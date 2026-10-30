package blobstore

import (
	"context"
	"errors"
	"net/http"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go/middleware"
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics are the object store's Prometheus metrics. Operations are the
// fixed set of S3 API operations the server calls, so label cardinality is
// bounded.
type Metrics struct {
	requests   *prometheus.CounterVec
	duration   *prometheus.HistogramVec
	uploaded   prometheus.Counter
	downloaded prometheus.Counter
}

// Request outcomes.
const (
	outcomeOK       = "ok"
	outcomeNotFound = "not_found"
	outcomeError    = "error"
)

// NewMetrics returns unregistered object store metrics.
func NewMetrics() *Metrics {
	return &Metrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_sync_s3_requests_total",
			Help: "S3 operations, retries included, by operation and outcome.",
		}, []string{"operation", "outcome"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vault_sync_s3_request_duration_seconds",
			Help:    "S3 operation time, retries included, by operation and outcome.",
			Buckets: prometheus.DefBuckets,
		}, []string{"operation", "outcome"}),
		uploaded: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_blob_uploaded_bytes_total",
			Help: "Blob chunk bytes clients uploaded that the server accepted.",
		}),
		downloaded: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_blob_downloaded_bytes_total",
			Help: "Blob bytes the server read for client downloads.",
		}),
	}
}

// Collectors returns the metrics, for registration.
func (metrics *Metrics) Collectors() []prometheus.Collector {
	return []prometheus.Collector{metrics.requests, metrics.duration, metrics.uploaded, metrics.downloaded}
}

// AddUploaded counts bytes of blob chunks a client uploaded.
func (metrics *Metrics) AddUploaded(bytes int) {
	if metrics != nil {
		metrics.uploaded.Add(float64(bytes))
	}
}

// AddDownloaded counts blob bytes read for a client's download.
func (metrics *Metrics) AddDownloaded(bytes int) {
	if metrics != nil {
		metrics.downloaded.Add(float64(bytes))
	}
}

// instrument adds a middleware timing every operation, retries included.
func (metrics *Metrics) instrument(options *s3.Options) {
	options.APIOptions = append(options.APIOptions, func(stack *middleware.Stack) error {
		return stack.Initialize.Add(middleware.InitializeMiddlewareFunc("VaultSyncMetrics",
			func(ctx context.Context, input middleware.InitializeInput, next middleware.InitializeHandler) (middleware.InitializeOutput, middleware.Metadata, error) {
				started := time.Now()
				output, metadata, err := next.HandleInitialize(ctx, input)

				operation, outcome := middleware.GetOperationName(ctx), requestOutcome(err)
				metrics.requests.WithLabelValues(operation, outcome).Inc()
				metrics.duration.WithLabelValues(operation, outcome).Observe(time.Since(started).Seconds())

				return output, metadata, err
			}), middleware.Before)
	})
}

// requestOutcome classifies an operation's error. A missing key or bucket is
// not_found: the server expects it, for example when deleting.
func requestOutcome(err error) string {
	if err == nil {
		return outcomeOK
	}

	var response *awshttp.ResponseError
	if errors.As(err, &response) && response.HTTPStatusCode() == http.StatusNotFound {
		return outcomeNotFound
	}

	return outcomeError
}
