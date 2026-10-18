package store

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgconn"
)

// applyTLSFiles replaces the TLS configuration pgx derived from the DSN with
// one that reads the configured certificate files on every handshake, so that
// rotated certificates take effect for new connections (SPEC.md §3).
func applyTLSFiles(connConfig *pgconn.Config, cfg Config) error {
	if hasStaticClientCertificate(connConfig) {
		return errors.New("database DSN must not set sslcert/sslkey: they are read only once; use the client certificate file settings so rotated certificates are picked up")
	}

	if cfg.TLSCertFile == "" && cfg.TLSKeyFile == "" && cfg.TLSCAFile == "" {
		return nil
	}

	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return errors.New("database client certificate and key files must be set together")
	}

	// Fail fast on unreadable or invalid files instead of on first connect.
	if cfg.TLSCertFile != "" {
		if _, err := loadClientCertificate(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil {
			return err
		}
	}

	if cfg.TLSCAFile != "" {
		if _, err := loadCAPool(cfg.TLSCAFile); err != nil {
			return err
		}
	}

	if connConfig.TLSConfig == nil {
		return errors.New("database TLS files are set but the DSN disables TLS: use sslmode=require, verify-ca or verify-full")
	}

	connConfig.TLSConfig = rotatingTLSConfig(connConfig.TLSConfig, connConfig.Host, cfg)

	// Drop plaintext fallbacks (sslmode=prefer) so a TLS failure can never
	// silently downgrade to an unauthenticated connection.
	fallbacks := connConfig.Fallbacks[:0]

	for _, fallback := range connConfig.Fallbacks {
		if fallback.TLSConfig == nil {
			continue
		}

		fallback.TLSConfig = rotatingTLSConfig(fallback.TLSConfig, fallback.Host, cfg)
		fallbacks = append(fallbacks, fallback)
	}

	connConfig.Fallbacks = fallbacks

	return nil
}

func hasStaticClientCertificate(connConfig *pgconn.Config) bool {
	if connConfig.TLSConfig != nil && len(connConfig.TLSConfig.Certificates) > 0 {
		return true
	}

	for _, fallback := range connConfig.Fallbacks {
		if fallback.TLSConfig != nil && len(fallback.TLSConfig.Certificates) > 0 {
			return true
		}
	}

	return false
}

// rotatingTLSConfig derives a TLS configuration for host from base that loads
// the client certificate and CA bundle from disk for each handshake.
func rotatingTLSConfig(base *tls.Config, host string, cfg Config) *tls.Config {
	tlsConfig := base.Clone()

	if cfg.TLSCertFile != "" {
		certFile, keyFile := cfg.TLSCertFile, cfg.TLSKeyFile
		tlsConfig.Certificates = nil
		tlsConfig.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			return loadClientCertificate(certFile, keyFile)
		}
	}

	if cfg.TLSCAFile != "" {
		caFile := cfg.TLSCAFile
		// The standard verification uses a fixed RootCAs pool, so it is
		// disabled and replaced by VerifyConnection, which re-reads the CA
		// bundle and verifies both the chain and the host name.
		tlsConfig.InsecureSkipVerify = true
		tlsConfig.RootCAs = nil
		tlsConfig.VerifyPeerCertificate = nil
		tlsConfig.VerifyConnection = func(state tls.ConnectionState) error {
			return verifyServerCertificate(state, caFile, host)
		}
	}

	return tlsConfig
}

func loadClientCertificate(certFile, keyFile string) (*tls.Certificate, error) {
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load database client certificate: %w", err)
	}

	return &certificate, nil
}

func loadCAPool(caFile string) (*x509.CertPool, error) {
	pemData, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read database CA file: %w", err)
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemData) {
		return nil, fmt.Errorf("database CA file %q contains no PEM certificates", caFile)
	}

	return pool, nil
}

func verifyServerCertificate(state tls.ConnectionState, caFile, host string) error {
	if len(state.PeerCertificates) == 0 {
		return errors.New("database server presented no certificate")
	}

	roots, err := loadCAPool(caFile)
	if err != nil {
		return err
	}

	intermediates := x509.NewCertPool()
	for _, certificate := range state.PeerCertificates[1:] {
		intermediates.AddCert(certificate)
	}

	_, err = state.PeerCertificates[0].Verify(x509.VerifyOptions{
		DNSName:       host,
		Roots:         roots,
		Intermediates: intermediates,
	})
	if err != nil {
		return fmt.Errorf("verify database server certificate: %w", err)
	}

	return nil
}
