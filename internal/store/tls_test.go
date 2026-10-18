package store_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
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
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
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

// issue returns PEM certificate and key bytes for a leaf signed by the CA.
func (ca *testCA) issue(t *testing.T, commonName string, usage x509.ExtKeyUsage, ip net.IP) (certPEM, keyPEM []byte) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)

	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
	}
	if ip != nil {
		template.IPAddresses = []net.IP{ip}
	}

	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	require.NoError(t, err)

	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)

	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func (ca *testCA) serverCertificate(t *testing.T, ip net.IP) *tls.Certificate {
	t.Helper()

	certPEM, keyPEM := ca.issue(t, "postgres", x509.ExtKeyUsageServerAuth, ip)

	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	require.NoError(t, err)

	return &certificate
}

// fakePostgres accepts PostgreSQL SSLRequest negotiations, completes a TLS
// handshake requiring a client certificate, records the client certificate's
// common name, and hangs up.
type fakePostgres struct {
	listener          net.Listener
	serverCertificate atomic.Pointer[tls.Certificate]
	clientCommonNames chan string
}

func newFakePostgres(t *testing.T, clientCA *testCA, serverCertificate *tls.Certificate) *fakePostgres {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	server := &fakePostgres{listener: listener, clientCommonNames: make(chan string, 16)}
	server.serverCertificate.Store(serverCertificate)

	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(clientCA.certificate)

	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  clientCAs,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return server.serverCertificate.Load(), nil
		},
	}

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}

			server.handle(conn, tlsConfig)
		}
	}()

	t.Cleanup(func() { _ = listener.Close() })

	return server
}

func (server *fakePostgres) handle(conn net.Conn, tlsConfig *tls.Config) {
	defer func() { _ = conn.Close() }()

	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	request := make([]byte, 8)
	if _, err := io.ReadFull(conn, request); err != nil || binary.BigEndian.Uint32(request[4:]) != 80877103 {
		return
	}

	if _, err := conn.Write([]byte{'S'}); err != nil {
		return
	}

	tlsConn := tls.Server(conn, tlsConfig)
	if err := tlsConn.Handshake(); err != nil {
		return
	}

	server.clientCommonNames <- tlsConn.ConnectionState().PeerCertificates[0].Subject.CommonName
}

func (server *fakePostgres) port() int {
	return server.listener.Addr().(*net.TCPAddr).Port
}

// connect opens one connection with the store's configuration and returns
// the client certificate common name the server saw, or the client error.
func (server *fakePostgres) connect(t *testing.T, cfg store.Config) (string, error) {
	t.Helper()

	poolConfig, err := store.NewPoolConfig(cfg)
	require.NoError(t, err)

	conn, err := pgconn.ConnectConfig(t.Context(), &poolConfig.ConnConfig.Config)
	if conn != nil {
		_ = conn.Close(t.Context())
	}

	// The server records the handshake before hanging up, and the client
	// only returns after the hang-up, so no waiting is needed here.
	select {
	case commonName := <-server.clientCommonNames:
		return commonName, nil
	default:
		require.Error(t, err)

		return "", err
	}
}

func writeFile(t *testing.T, path string, contents []byte) {
	t.Helper()

	// Write and rename, as Kubernetes secret volume updates do.
	temporary := path + ".tmp"
	require.NoError(t, os.WriteFile(temporary, contents, 0o600))
	require.NoError(t, os.Rename(temporary, path))
}

type tlsFiles struct {
	cert, key, ca string
}

func newTLSFiles(t *testing.T) tlsFiles {
	t.Helper()

	dir := t.TempDir()

	return tlsFiles{
		cert: filepath.Join(dir, "tls.crt"),
		key:  filepath.Join(dir, "tls.key"),
		ca:   filepath.Join(dir, "ca.crt"),
	}
}

func (files tlsFiles) config(port int, sslmode string) store.Config {
	return store.Config{
		DSN:         fmt.Sprintf("host=127.0.0.1 port=%d user=test dbname=test sslmode=%s connect_timeout=5", port, sslmode),
		TLSCertFile: files.cert,
		TLSKeyFile:  files.key,
		TLSCAFile:   files.ca,
	}
}

var loopback = net.IPv4(127, 0, 0, 1)

func TestClientCertificateIsReReadForNewConnections(t *testing.T) {
	clientCA := newTestCA(t, "client-ca")
	serverCA := newTestCA(t, "server-ca")
	server := newFakePostgres(t, clientCA, serverCA.serverCertificate(t, loopback))

	files := newTLSFiles(t)
	writeFile(t, files.ca, serverCA.pem)

	certPEM, keyPEM := clientCA.issue(t, "client-1", x509.ExtKeyUsageClientAuth, nil)
	writeFile(t, files.cert, certPEM)
	writeFile(t, files.key, keyPEM)

	cfg := files.config(server.port(), "verify-full")

	commonName, err := server.connect(t, cfg)
	require.NoError(t, err)
	assert.Equal(t, "client-1", commonName)

	// Rotate the client certificate on disk; the same configuration must
	// present the new certificate on the next connection.
	certPEM, keyPEM = clientCA.issue(t, "client-2", x509.ExtKeyUsageClientAuth, nil)
	writeFile(t, files.cert, certPEM)
	writeFile(t, files.key, keyPEM)

	commonName, err = server.connect(t, cfg)
	require.NoError(t, err)
	assert.Equal(t, "client-2", commonName)
}

func TestServerCAIsReReadForNewConnections(t *testing.T) {
	clientCA := newTestCA(t, "client-ca")
	oldServerCA := newTestCA(t, "server-ca-1")
	newServerCA := newTestCA(t, "server-ca-2")
	server := newFakePostgres(t, clientCA, oldServerCA.serverCertificate(t, loopback))

	files := newTLSFiles(t)
	writeFile(t, files.ca, oldServerCA.pem)

	certPEM, keyPEM := clientCA.issue(t, "client", x509.ExtKeyUsageClientAuth, nil)
	writeFile(t, files.cert, certPEM)
	writeFile(t, files.key, keyPEM)

	cfg := files.config(server.port(), "verify-full")

	_, err := server.connect(t, cfg)
	require.NoError(t, err)

	// The server moves to a certificate from a new CA that the client does
	// not trust yet: the handshake must fail.
	server.serverCertificate.Store(newServerCA.serverCertificate(t, loopback))

	_, err = server.connect(t, cfg)
	require.ErrorContains(t, err, "verify database server certificate")

	// Once the new CA bundle is on disk, new connections trust it.
	writeFile(t, files.ca, newServerCA.pem)

	_, err = server.connect(t, cfg)
	require.NoError(t, err)
}

func TestCAFileEnforcesHostNameVerification(t *testing.T) {
	clientCA := newTestCA(t, "client-ca")
	serverCA := newTestCA(t, "server-ca")
	// Valid chain, but issued for a different address.
	server := newFakePostgres(t, clientCA, serverCA.serverCertificate(t, net.IPv4(192, 0, 2, 1)))

	files := newTLSFiles(t)
	writeFile(t, files.ca, serverCA.pem)

	certPEM, keyPEM := clientCA.issue(t, "client", x509.ExtKeyUsageClientAuth, nil)
	writeFile(t, files.cert, certPEM)
	writeFile(t, files.key, keyPEM)

	for _, sslmode := range []string{"require", "verify-ca", "verify-full"} {
		t.Run(sslmode, func(t *testing.T) {
			_, err := server.connect(t, files.config(server.port(), sslmode))
			require.ErrorContains(t, err, "verify database server certificate")
		})
	}
}

func TestNewPoolConfig(t *testing.T) {
	clientCA := newTestCA(t, "client-ca")
	files := newTLSFiles(t)
	certPEM, keyPEM := clientCA.issue(t, "client", x509.ExtKeyUsageClientAuth, nil)
	writeFile(t, files.cert, certPEM)
	writeFile(t, files.key, keyPEM)
	writeFile(t, files.ca, clientCA.pem)

	tests := []struct {
		name   string
		config store.Config
		// check inspects a successfully parsed configuration.
		check     func(t *testing.T, connConfig *pgconn.Config)
		assertErr require.ErrorAssertionFunc
	}{
		{
			name:   "plain DSN without TLS files",
			config: store.Config{DSN: "postgres://user@db.example/vault_sync?sslmode=disable"},
			check: func(t *testing.T, connConfig *pgconn.Config) {
				assert.Nil(t, connConfig.TLSConfig)
			},
		},
		{
			name:      "empty DSN",
			config:    store.Config{},
			assertErr: require.Error,
		},
		{
			name:      "TLS files with TLS disabled",
			config:    store.Config{DSN: "host=db.example sslmode=disable", TLSCertFile: files.cert, TLSKeyFile: files.key},
			assertErr: require.Error,
		},
		{
			name:      "certificate without key",
			config:    store.Config{DSN: "host=db.example sslmode=verify-full", TLSCertFile: files.cert},
			assertErr: require.Error,
		},
		{
			name:      "missing certificate file",
			config:    store.Config{DSN: "host=db.example sslmode=verify-full", TLSCertFile: files.cert + ".missing", TLSKeyFile: files.key},
			assertErr: require.Error,
		},
		{
			name:      "CA file without certificates",
			config:    store.Config{DSN: "host=db.example sslmode=verify-full", TLSCAFile: files.key},
			assertErr: require.Error,
		},
		{
			name:      "static client certificate in DSN",
			config:    store.Config{DSN: fmt.Sprintf("host=db.example sslmode=verify-full sslcert=%s sslkey=%s", files.cert, files.key)},
			assertErr: require.Error,
		},
		{
			name:   "prefer drops the plaintext fallback",
			config: store.Config{DSN: "host=db.example sslmode=prefer", TLSCertFile: files.cert, TLSKeyFile: files.key, TLSCAFile: files.ca},
			check: func(t *testing.T, connConfig *pgconn.Config) {
				require.NotNil(t, connConfig.TLSConfig)
				assert.Empty(t, connConfig.TLSConfig.Certificates)
				assert.NotNil(t, connConfig.TLSConfig.GetClientCertificate)

				for _, fallback := range connConfig.Fallbacks {
					assert.NotNil(t, fallback.TLSConfig, "plaintext fallback for host %q", fallback.Host)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.assertErr == nil {
				test.assertErr = require.NoError
			}

			poolConfig, err := store.NewPoolConfig(test.config)
			test.assertErr(t, err)

			if err == nil && test.check != nil {
				test.check(t, &poolConfig.ConnConfig.Config)
			}
		})
	}
}
