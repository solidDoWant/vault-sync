package blobstore

import (
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestBoundIdleConnectionsOffersOnlyHTTP1 proves that a store (or a proxy in
// front of it) that offers HTTP/2 is never sent an HTTP/2 ALPN offer: the
// transport only speaks HTTP/1.1, so a server that selected h2 would get
// HTTP/1.1 requests and reset the connection. The SDK's default TLS config
// offers h2, which clearing TLSNextProto alone does not remove.
//
// This is the path without a configured CA file, where the SDK's TLS config
// is used as it is.
func TestBoundIdleConnectionsOffersOnlyHTTP1(t *testing.T) {
	var negotiated, protoMajor atomic.Value

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		negotiated.Store(request.TLS.NegotiatedProtocol)
		protoMajor.Store(request.ProtoMajor)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)

	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())

	client := awshttp.NewBuildableClient().WithTransportOptions(
		func(transport *http.Transport) { boundIdleConnections(transport, time.Minute) },
		func(transport *http.Transport) { transport.TLSClientConfig.RootCAs = roots },
	)

	request, err := http.NewRequestWithContext(t.Context(), http.MethodHead, server.URL, nil)
	require.NoError(t, err)

	response, err := client.Do(request)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())

	assert.Equal(t, 1, protoMajor.Load(), "request protocol major version")
	assert.NotEqual(t, "h2", negotiated.Load(), "negotiated ALPN protocol")
}
