package config_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestLoadRetentionCommand(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want config.RetentionCommandConfig
		// wantProblems are substrings that must each appear in the error.
		wantProblems []string
	}{
		{
			name: "the database only; the minimum keep-all is a day",
			env:  map[string]string{config.DatabaseURLEnv: testDSN},
			want: config.RetentionCommandConfig{Database: store.Config{DSN: testDSN}, MinKeepAll: 24 * time.Hour},
		},
		{
			name: "operator minimums; server and S3 variables are ignored, even when invalid",
			env: map[string]string{
				config.DatabaseURLEnv: testDSN, config.RetentionOverrideMinKeepAllEnv: "720h",
				config.RetentionOverrideMinKeepDailyEnv: "2160h", config.S3BucketEnv: "incomplete", config.LogLevelEnv: "loud",
			},
			want: config.RetentionCommandConfig{Database: store.Config{DSN: testDSN}, MinKeepAll: 720 * time.Hour, MinKeepDaily: 2160 * time.Hour},
		},
		{
			name: "a minimum keep-all of exactly a day",
			env:  map[string]string{config.DatabaseURLEnv: testDSN, config.RetentionOverrideMinKeepAllEnv: "24h"},
			want: config.RetentionCommandConfig{Database: store.Config{DSN: testDSN}, MinKeepAll: 24 * time.Hour},
		},
		{
			name:         "a minimum keep-all below a day",
			env:          map[string]string{config.DatabaseURLEnv: testDSN, config.RetentionOverrideMinKeepAllEnv: "23h59m59s"},
			wantProblems: []string{config.RetentionOverrideMinKeepAllEnv},
		},
		{
			name:         "a malformed minimum",
			env:          map[string]string{config.DatabaseURLEnv: testDSN, config.RetentionOverrideMinKeepDailyEnv: "90d"},
			wantProblems: []string{config.RetentionOverrideMinKeepDailyEnv},
		},
		{
			name:         "the database is required",
			env:          map[string]string{},
			wantProblems: []string{config.DatabaseURLEnv},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := config.LoadRetentionCommand(lookup(test.env))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg)
		})
	}
}
