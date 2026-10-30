package blobstore_test

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

// collectorNamed returns the collector among metrics' collectors that
// describes the metric name.
func collectorNamed(t *testing.T, metrics *blobstore.Metrics, name string) prometheus.Collector {
	t.Helper()

	for _, collector := range metrics.Collectors() {
		descs := make(chan *prometheus.Desc, 1)
		collector.Describe(descs)

		if strings.Contains((<-descs).String(), `"`+name+`"`) {
			return collector
		}
	}

	require.Failf(t, "no collector", "%s", name)

	return nil
}

func TestObjectStoreMetricsCountOperationsByOutcome(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodHead:
			writer.WriteHeader(http.StatusOK)
		case http.MethodGet:
			writer.Header().Set("Content-Type", "application/xml")
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`<Error><Code>NoSuchKey</Code></Error>`))
		default:
			// A client error, which the SDK does not retry.
			writer.WriteHeader(http.StatusForbidden)
		}
	}))
	t.Cleanup(server.Close)

	credentialsFile := filepath.Join(t.TempDir(), "credential")
	writeTestFile(t, credentialsFile, []byte("value"))

	metrics := blobstore.NewMetrics()
	objects, err := blobstore.NewWithMetrics(blobstore.Config{
		Endpoint:            server.URL,
		Bucket:              "vault-sync",
		AccessKeyIDFile:     credentialsFile,
		SecretAccessKeyFile: credentialsFile,
		ForcePathStyle:      true,
	}, metrics)
	require.NoError(t, err)

	require.NoError(t, objects.Check(t.Context()))
	require.NoError(t, objects.Check(t.Context()))

	_, err = objects.Open(t.Context(), "missing")
	require.ErrorIs(t, err, blobstore.ErrNoObject)

	require.Error(t, objects.Put(t.Context(), "key", []byte("data")))

	requests, ok := collectorNamed(t, metrics, "vault_sync_s3_requests_total").(*prometheus.CounterVec)
	require.True(t, ok)

	durations, ok := collectorNamed(t, metrics, "vault_sync_s3_request_duration_seconds").(*prometheus.HistogramVec)
	require.True(t, ok)

	expected := []struct {
		operation, outcome string
		count              float64
	}{
		{operation: "HeadBucket", outcome: "ok", count: 2},
		{operation: "GetObject", outcome: "not_found", count: 1},
		{operation: "PutObject", outcome: "error", count: 1},
	}

	for _, operation := range expected {
		assert.Equal(t, operation.count, testutil.ToFloat64(requests.WithLabelValues(operation.operation, operation.outcome)),
			"%s %s", operation.operation, operation.outcome)
	}

	assert.Equal(t, len(expected), testutil.CollectAndCount(requests), "no other operations or outcomes")
	assert.Equal(t, len(expected), testutil.CollectAndCount(durations), "a duration for each operation and outcome")
}

func TestBlobByteMetricsCountUploadsAndDownloads(t *testing.T) {
	metrics := blobstore.NewMetrics()
	metrics.AddUploaded(5)
	metrics.AddUploaded(7)
	metrics.AddDownloaded(3)

	assert.Equal(t, 12.0, testutil.ToFloat64(collectorNamed(t, metrics, "vault_sync_blob_uploaded_bytes_total")))
	assert.Equal(t, 3.0, testutil.ToFloat64(collectorNamed(t, metrics, "vault_sync_blob_downloaded_bytes_total")))

	var unset *blobstore.Metrics
	unset.AddUploaded(1)
	unset.AddDownloaded(1)
}
