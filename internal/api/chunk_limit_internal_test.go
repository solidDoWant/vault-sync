package api

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #161: every JSON media type a Connect handler serves gets the base64-cut
// chunk limit, whatever its parameters; binary ones keep MaxChunkBytes.
func TestChunkLimitFollowsTheRequestsCodec(t *testing.T) {
	// The defaults: a 1 MiB message limit and 768 KiB chunks. 784878 is
	// the JSON chunk docs/configuration.md documents for them.
	service := BlobService{Limits: BlobLimits{MaxChunkBytes: 768 << 10, MaxMessageBytes: 1 << 20}}

	tests := []struct {
		contentType string
		want        int64
	}{
		{contentType: "application/json", want: 784878},
		{contentType: "application/json; charset=utf-8", want: 784878},
		{contentType: "Application/JSON", want: 784878},
		{contentType: "application/connect+json", want: 784878},
		{contentType: "application/grpc+json", want: 784878},
		{contentType: "application/grpc-web+json", want: 784878},
		{contentType: "application/grpc-web+json; charset=utf-8", want: 784878},
		{contentType: "application/proto", want: 768 << 10},
		{contentType: "application/connect+proto", want: 768 << 10},
		{contentType: "application/grpc", want: 768 << 10},
		{contentType: "application/grpc+proto", want: 768 << 10},
		{contentType: "application/grpc-web+proto", want: 768 << 10},
	}

	for _, test := range tests {
		t.Run(test.contentType, func(t *testing.T) {
			header := http.Header{"Content-Type": []string{test.contentType}}
			assert.Equal(t, test.want, service.chunkLimit(header))
		})
	}
}

// #161: a binary range leaves room for gzip's framing of incompressible
// content only where the chunk's reserve does not already cover it.
func TestBinaryRangesLeaveRoomForGzipFraming(t *testing.T) {
	binary := http.Header{"Content-Type": []string{"application/proto"}}

	tests := []struct {
		name   string
		limits BlobLimits
		want   int64
	}{
		{name: "default limits", limits: BlobLimits{MaxChunkBytes: 768 << 10, MaxMessageBytes: 1 << 20}, want: 768 << 10},
		{name: "smallest limits", limits: BlobLimits{MaxChunkBytes: 64 << 10, MaxMessageBytes: 64<<10 + 1<<10}, want: 64 << 10},
		{
			// 64 MiB less a thousandth (67108) and half the reserve (512).
			name:   "largest limits",
			limits: BlobLimits{MaxChunkBytes: 64<<20 - 1<<10, MaxMessageBytes: 64 << 20},
			want:   64<<20 - 67108 - 512,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, BlobService{Limits: test.limits}.rangeLimit(binary))
		})
	}
}
