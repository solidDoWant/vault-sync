package blobstore_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

type testCA struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pem         []byte
}

func newTestCA(t *testing.T, name string) *testCA {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	require.NoError(t, err)

	certificate, err := x509.ParseCertificate(der)
	require.NoError(t, err)

	return &testCA{
		certificate: certificate,
		key:         key,
		pem:         pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

// issue returns a server certificate signed by the CA naming exactly
// dnsNames and ipAddresses.
func (ca *testCA) issue(t *testing.T, dnsNames []string, ipAddresses []net.IP) *tls.Certificate {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)

	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "s3"},
		DNSNames:     dnsNames,
		IPAddresses:  ipAddresses,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	require.NoError(t, err)

	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// fakeS3 is a TLS server on 127.0.0.1 that answers every request with 200
// and presents whatever certificate is currently stored.
type fakeS3 struct {
	server      *httptest.Server
	certificate atomic.Pointer[tls.Certificate]
}

func newFakeS3(t *testing.T, certificate *tls.Certificate) *fakeS3 {
	t.Helper()

	fake := &fakeS3{}
	fake.certificate.Store(certificate)

	fake.server = httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	fake.server.TLS = &tls.Config{
		MinVersion: tls.VersionTLS12,
		// GetConfigForClient runs for every handshake; GetCertificate would
		// be skipped without SNI, which clients never send to an IP address.
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{*fake.certificate.Load()}}, nil
		},
	}
	// Rejected handshakes are expected; keep them out of the test output.
	fake.server.Config.ErrorLog = log.New(io.Discard, "", 0)
	fake.server.StartTLS()
	t.Cleanup(fake.server.Close)

	return fake
}

// endpoint returns the server's URL with its host replaced by host.
func (fake *fakeS3) endpoint(t *testing.T, host string) string {
	t.Helper()

	parsed, err := url.Parse(fake.server.URL)
	require.NoError(t, err)

	parsed.Host = net.JoinHostPort(host, parsed.Port())

	return parsed.String()
}

func writeTestFile(t *testing.T, path string, contents []byte) {
	t.Helper()

	// Write and rename, as a Kubernetes Secret volume update does, so that
	// a concurrent reader never sees a partial file.
	temporary := path + ".tmp"
	require.NoError(t, os.WriteFile(temporary, contents, 0o600))
	require.NoError(t, os.Rename(temporary, path))
}

func newTLSObjects(t *testing.T, endpoint, caFile string) *blobstore.Objects {
	t.Helper()

	credentialsFile := filepath.Join(t.TempDir(), "credential")
	writeTestFile(t, credentialsFile, []byte("value"))

	objects, err := blobstore.New(blobstore.Config{
		Endpoint:            endpoint,
		Bucket:              "vault-sync",
		AccessKeyIDFile:     credentialsFile,
		SecretAccessKeyFile: credentialsFile,
		ForcePathStyle:      true,
		TLSCAFile:           caFile,
	})
	require.NoError(t, err)

	return objects
}

// requireCertificateRejected is a require.ErrorAssertionFunc accepting only a
// certificate verification error.
func requireCertificateRejected(t require.TestingT, err error, _ ...any) {
	if helper, ok := t.(interface{ Helper() }); ok {
		helper.Helper()
	}

	require.Error(t, err)

	var hostnameError x509.HostnameError

	var unknownAuthority x509.UnknownAuthorityError

	require.True(t, errors.As(err, &hostnameError) || errors.As(err, &unknownAuthority),
		"want a certificate verification error, got %v", err)
}

// headBucket sends one HeadBucket request through the client blobstore built,
// without the SDK's retries, so a rejected handshake fails fast.
func headBucket(t *testing.T, objects *blobstore.Objects) error {
	t.Helper()

	_, err := objects.Client().HeadBucket(t.Context(), &s3.HeadBucketInput{Bucket: aws.String(objects.Bucket())},
		func(options *s3.Options) { options.RetryMaxAttempts = 1 })

	return err
}

var loopback = net.IPv4(127, 0, 0, 1)

func TestCAFileVerifiesTheEndpointHost(t *testing.T) {
	ca := newTestCA(t, "s3-ca")

	tests := []struct {
		name        string
		host        string
		certificate *tls.Certificate
		wantErr     require.ErrorAssertionFunc
	}{
		{
			// Regression for #138: no SNI is sent for an IP literal, so the
			// host check must not depend on it.
			name:        "IP endpoint, certificate for another host name",
			host:        "127.0.0.1",
			certificate: ca.issue(t, []string{"attacker.example"}, nil),
			wantErr:     requireCertificateRejected,
		},
		{
			name:        "IP endpoint, certificate for another IP address",
			host:        "127.0.0.1",
			certificate: ca.issue(t, nil, []net.IP{net.IPv4(192, 0, 2, 1)}),
			wantErr:     requireCertificateRejected,
		},
		{
			name:        "IP endpoint, host name SAN spelling the IP address",
			host:        "127.0.0.1",
			certificate: ca.issue(t, []string{"127.0.0.1"}, nil),
			wantErr:     requireCertificateRejected,
		},
		{
			name:        "IP endpoint, matching IP SAN",
			host:        "127.0.0.1",
			certificate: ca.issue(t, nil, []net.IP{loopback}),
		},
		{
			name:        "host name endpoint, certificate for another host name",
			host:        "localhost",
			certificate: ca.issue(t, []string{"attacker.example"}, []net.IP{loopback}),
			wantErr:     requireCertificateRejected,
		},
		{
			name:        "host name endpoint, matching DNS SAN",
			host:        "localhost",
			certificate: ca.issue(t, []string{"localhost"}, nil),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr == nil {
				test.wantErr = require.NoError
			}

			server := newFakeS3(t, test.certificate)

			caFile := filepath.Join(t.TempDir(), "ca.pem")
			writeTestFile(t, caFile, ca.pem)

			objects := newTLSObjects(t, server.endpoint(t, test.host), caFile)

			// Every request is rejected, not only the first.
			for range 2 {
				test.wantErr(t, headBucket(t, objects))
			}
		})
	}
}

func TestCAFileIsReReadForNewConnectionsToAnIPEndpoint(t *testing.T) {
	oldCA := newTestCA(t, "s3-ca-1")
	newCA := newTestCA(t, "s3-ca-2")
	server := newFakeS3(t, oldCA.issue(t, nil, []net.IP{loopback}))

	caFile := filepath.Join(t.TempDir(), "ca.pem")
	writeTestFile(t, caFile, oldCA.pem)

	objects := newTLSObjects(t, server.endpoint(t, "127.0.0.1"), caFile)
	require.NoError(t, headBucket(t, objects))

	// Replace the bundle on disk with one that no longer trusts the
	// server's CA and drop the pooled connection: the same client must
	// reject the server on its next connection, without a restart.
	writeTestFile(t, caFile, newCA.pem)
	server.server.CloseClientConnections()
	requireCertificateRejected(t, headBucket(t, objects))

	// Once the server presents a certificate from the CA now on disk, the
	// same client trusts it again.
	server.certificate.Store(newCA.issue(t, nil, []net.IP{loopback}))
	require.NoError(t, headBucket(t, objects))
}
