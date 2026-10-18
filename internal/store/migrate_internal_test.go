package store

import (
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadMigrations(t *testing.T) {
	file := func(contents string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(contents)} }

	tests := []struct {
		name      string
		files     fstest.MapFS
		expected  []migration
		assertErr require.ErrorAssertionFunc
	}{
		{
			name: "sorted by version",
			files: fstest.MapFS{
				"migrations/0010_later.sql":   file("SELECT 10"),
				"migrations/0002_second.sql":  file("SELECT 2"),
				"migrations/0001_initial.sql": file("SELECT 1"),
			},
			expected: []migration{
				{version: 1, name: "initial", sql: "SELECT 1"},
				{version: 2, name: "second", sql: "SELECT 2"},
				{version: 10, name: "later", sql: "SELECT 10"},
			},
		},
		{
			name:      "invalid file name",
			files:     fstest.MapFS{"migrations/initial.sql": file("SELECT 1")},
			assertErr: require.Error,
		},
		{
			name:      "version zero",
			files:     fstest.MapFS{"migrations/0000_zero.sql": file("SELECT 1")},
			assertErr: require.Error,
		},
		{
			name: "duplicate version",
			files: fstest.MapFS{
				"migrations/0001_a.sql":  file("SELECT 1"),
				"migrations/00001_b.sql": file("SELECT 1"),
			},
			assertErr: require.Error,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.assertErr == nil {
				test.assertErr = require.NoError
			}

			migrations, err := loadMigrations(test.files)
			test.assertErr(t, err)
			assert.Equal(t, test.expected, migrations)
		})
	}
}

func TestEmbeddedMigrationsAreValid(t *testing.T) {
	migrations, err := loadMigrations(embeddedMigrations)
	require.NoError(t, err)
	require.NotEmpty(t, migrations)

	for index, migration := range migrations {
		assert.Equal(t, int64(index+1), migration.version, "migration versions must be contiguous from 1")
	}
}
