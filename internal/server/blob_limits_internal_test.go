package server

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/config"
)

func TestBlobServiceEnforcesTheConfiguredBlobLimits(t *testing.T) {
	// Every limit has a value no other limit has, so dropping or swapping
	// one fails.
	blobs := config.BlobConfig{
		MaxChunkBytes:      3 << 20,
		MaxSizeBytes:       5 << 30,
		MaxUploadsPerVault: 17,
		UploadTTL:          48 * time.Hour,
		UploadReclaimIdle:  7 * time.Minute,
	}

	assert.Equal(t, api.BlobLimits{
		MaxChunkBytes:      3 << 20,
		MaxBlobBytes:       5 << 30,
		MaxUploadsPerVault: 17,
		UploadReclaimIdle:  7 * time.Minute,
	}, blobLimits(blobs))
}
