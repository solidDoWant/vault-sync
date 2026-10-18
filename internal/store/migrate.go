package store

import (
	"cmp"
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"regexp"
	"slices"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var embeddedMigrations embed.FS

// migrationLockKey is the pg_advisory_lock key that serializes migrations
// across server processes sharing a database. The value is arbitrary but must
// never change; it spells "vsyncmig" in ASCII.
const migrationLockKey int64 = 0x7673796e636d6967

var migrationFileName = regexp.MustCompile(`^(\d{4,})_([a-z0-9_]+)\.sql$`)

type migration struct {
	version int64
	name    string
	sql     string
}

// Migrate applies every embedded migration that has not yet been applied and
// returns how many it applied. It holds a PostgreSQL advisory lock while it
// runs, so concurrently starting servers apply each migration exactly once;
// the others wait and then find nothing to do. Each migration runs in its own
// transaction and is recorded in schema_migrations.
//
// Migrations are forward-only. Versions recorded in the database but unknown
// to this binary (applied by a newer release) are ignored, because each
// release's schema stays compatible with the previous release (SPEC.md §12).
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) (int, error) {
	migrations, err := loadMigrations(embeddedMigrations)
	if err != nil {
		return 0, err
	}

	return applyMigrations(ctx, pool, logger, migrations)
}

func loadMigrations(fsys fs.FS) ([]migration, error) {
	paths, err := fs.Glob(fsys, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}

	migrations := make([]migration, 0, len(paths))
	seen := make(map[int64]string, len(paths))

	for _, filePath := range paths {
		fileName := path.Base(filePath)

		match := migrationFileName.FindStringSubmatch(fileName)
		if match == nil {
			return nil, fmt.Errorf("migration %q: file name must look like 0001_description.sql", fileName)
		}

		version, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("migration %q: invalid version", fileName)
		}

		if other, ok := seen[version]; ok {
			return nil, fmt.Errorf("migrations %q and %q share version %d", other, fileName, version)
		}

		seen[version] = fileName

		contents, err := fs.ReadFile(fsys, filePath)
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", fileName, err)
		}

		migrations = append(migrations, migration{version: version, name: match[2], sql: string(contents)})
	}

	slices.SortFunc(migrations, func(a, b migration) int { return cmp.Compare(a.version, b.version) })

	return migrations, nil
}

func applyMigrations(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, migrations []migration) (applied int, err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, fmt.Errorf("acquire migration connection: %w", err)
	}

	// The advisory lock is held by this session, so every statement below
	// must use conn.
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey); err != nil {
		conn.Release()

		return 0, fmt.Errorf("acquire migration lock: %w", err)
	}

	defer func() {
		_, unlockErr := conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", migrationLockKey)
		if unlockErr != nil {
			// Closing the session releases the lock; never return a
			// connection that may still hold it to the pool.
			_ = conn.Hijack().Close(context.WithoutCancel(ctx))
			err = errors.Join(err, fmt.Errorf("release migration lock: %w", unlockErr))

			return
		}

		conn.Release()
	}()

	_, err = conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version     bigint      PRIMARY KEY,
		name        text        NOT NULL,
		applied_at  timestamptz NOT NULL DEFAULT now()
	)`)
	if err != nil {
		return 0, fmt.Errorf("create schema_migrations: %w", err)
	}

	appliedNames, err := appliedMigrations(ctx, conn.Conn())
	if err != nil {
		return 0, err
	}

	for _, pending := range migrations {
		if name, ok := appliedNames[pending.version]; ok {
			if name != pending.name {
				return applied, fmt.Errorf("migration %d is recorded as %q but embedded as %q: released migrations must never change", pending.version, name, pending.name)
			}

			continue
		}

		if err := applyMigration(ctx, conn.Conn(), pending); err != nil {
			return applied, err
		}

		applied++

		logger.InfoContext(ctx, "applied database migration", "version", pending.version, "name", pending.name)
	}

	return applied, nil
}

func appliedMigrations(ctx context.Context, conn *pgx.Conn) (map[int64]string, error) {
	rows, err := conn.Query(ctx, "SELECT version, name FROM schema_migrations")
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}

	applied := make(map[int64]string)

	var (
		version int64
		name    string
	)

	_, err = pgx.ForEachRow(rows, []any{&version, &name}, func() error {
		applied[version] = name

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}

	return applied, nil
}

func applyMigration(ctx context.Context, conn *pgx.Conn, pending migration) error {
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		// Without arguments pgx uses the simple protocol, which allows a
		// migration file to contain several statements.
		if _, err := tx.Exec(ctx, pending.sql); err != nil {
			return err
		}

		_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", pending.version, pending.name)

		return err
	})
	if err != nil {
		return fmt.Errorf("apply migration %d (%s): %w", pending.version, pending.name, err)
	}

	return nil
}
