package blobstore_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

func TestCredentialsFollowTheirFiles(t *testing.T) {
	directory := t.TempDir()
	accessKeyFile := filepath.Join(directory, "access-key-id")
	secretKeyFile := filepath.Join(directory, "secret-access-key")

	require.NoError(t, os.WriteFile(accessKeyFile, []byte("first-key\n"), 0o600))
	require.NoError(t, os.WriteFile(secretKeyFile, []byte("first-secret\n"), 0o600))

	objects, err := blobstore.New(blobstore.Config{
		Endpoint:                   "http://127.0.0.1:1",
		Bucket:                     "vault-sync",
		AccessKeyIDFile:            accessKeyFile,
		SecretAccessKeyFile:        secretKeyFile,
		CredentialsRefreshInterval: 20 * time.Millisecond,
	})
	require.NoError(t, err)

	credentials := objects.Client().Options().Credentials

	first, err := credentials.Retrieve(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "first-key", first.AccessKeyID)
	assert.Equal(t, "first-secret", first.SecretAccessKey)
	assert.True(t, first.CanExpire, "credentials are not cached for the process lifetime")

	// Kubernetes rotates a mounted Secret by swapping the files.
	require.NoError(t, os.WriteFile(accessKeyFile, []byte("second-key"), 0o600))
	require.NoError(t, os.WriteFile(secretKeyFile, []byte("second-secret"), 0o600))

	assert.Eventually(t, func() bool {
		current, err := credentials.Retrieve(t.Context())

		return err == nil && current.AccessKeyID == "second-key" && current.SecretAccessKey == "second-secret"
	}, 5*time.Second, 10*time.Millisecond)
}

func TestConfigValidate(t *testing.T) {
	directory := t.TempDir()
	keyFile := filepath.Join(directory, "key")
	require.NoError(t, os.WriteFile(keyFile, []byte("value"), 0o600))

	valid := blobstore.Config{Bucket: "b", AccessKeyIDFile: keyFile, SecretAccessKeyFile: keyFile}

	tests := []struct {
		name    string
		modify  func(*blobstore.Config)
		wantErr require.ErrorAssertionFunc
	}{
		{name: "valid", modify: func(*blobstore.Config) {}},
		{name: "https endpoint", modify: func(cfg *blobstore.Config) { cfg.Endpoint = "https://rgw.example" }},
		{name: "no bucket", modify: func(cfg *blobstore.Config) { cfg.Bucket = "" }, wantErr: require.Error},
		{name: "no credentials", modify: func(cfg *blobstore.Config) { cfg.SecretAccessKeyFile = "" }, wantErr: require.Error},
		{name: "relative endpoint", modify: func(cfg *blobstore.Config) { cfg.Endpoint = "rgw.example" }, wantErr: require.Error},
		{name: "ftp endpoint", modify: func(cfg *blobstore.Config) { cfg.Endpoint = "ftp://rgw.example" }, wantErr: require.Error},
		{name: "CA file without certificates", modify: func(cfg *blobstore.Config) { cfg.TLSCAFile = keyFile }, wantErr: require.Error},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr == nil {
				test.wantErr = require.NoError
			}

			cfg := valid
			test.modify(&cfg)
			test.wantErr(t, cfg.Validate())
		})
	}
}
