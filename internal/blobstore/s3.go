// Package blobstore stores blob contents in an S3-compatible object store
// (SPEC.md §5, §6.2).
//
// Layout (decision): a complete blob is one object at
// vaults/{vault_id}/blobs/{hex(blob_id)}. An upload in progress stores each
// accepted chunk as its own staged object under
// vaults/{vault_id}/uploads/{upload_id}/, and CommitBlob composes the staged
// chunks into the blob's object by streaming them through the server. S3
// multipart parts (and UploadPartCopy sources) must be at least 5 MiB except
// the last, which chunks below the gateway's 1 MiB body limit can never be, so
// chunks cannot be uploaded or copied as parts directly. While composing,
// the server hashes the content and only writes (PutObject) or completes
// (CompleteMultipartUpload) the blob's object once the hash matched, so a
// failed hash never produces a visible object.
package blobstore

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// DefaultCredentialsRefreshInterval is how long credentials read from the
// credential files are used before the files are read again.
const DefaultCredentialsRefreshInterval = 10 * time.Second

// DefaultRegion is used when no region is configured.
const DefaultRegion = "us-east-1"

// Config describes the S3-compatible object store.
type Config struct {
	// Endpoint is the store's base URL (for example https://rgw.example:443).
	// Empty selects AWS S3 for Region.
	Endpoint string
	// Region is the bucket's region. Most S3-compatible stores accept any
	// value; Ceph RGW and versitygw default to us-east-1.
	Region string
	// Bucket holds every vault's blobs. It must already exist.
	Bucket string
	// AccessKeyIDFile and SecretAccessKeyFile contain the credentials. They
	// are re-read every CredentialsRefreshInterval, so rotated credentials
	// are used without a restart (SPEC.md §12).
	AccessKeyIDFile     string
	SecretAccessKeyFile string
	// ForcePathStyle addresses the bucket as {endpoint}/{bucket} instead of
	// {bucket}.{endpoint}. Most self-hosted stores need it.
	ForcePathStyle bool
	// TLSCAFile, if set, is a PEM bundle of CAs trusted for the endpoint's
	// certificate instead of the system roots. It is re-read for every new
	// connection.
	TLSCAFile string
	// CredentialsRefreshInterval overrides
	// DefaultCredentialsRefreshInterval.
	CredentialsRefreshInterval time.Duration
}

// Validate checks cfg without contacting the store. Its errors name settings
// by their Config field, never by value for secrets.
func (cfg Config) Validate() error {
	var problems []error

	if cfg.Bucket == "" {
		problems = append(problems, errors.New("bucket is required"))
	}

	if cfg.Endpoint != "" {
		parsed, err := url.Parse(cfg.Endpoint)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" ||
			parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			problems = append(problems, fmt.Errorf("endpoint %q must be an http or https URL without credentials, query or fragment", cfg.Endpoint))
		}
	}

	if cfg.AccessKeyIDFile == "" || cfg.SecretAccessKeyFile == "" {
		problems = append(problems, errors.New("access key id file and secret access key file are required"))
	} else if _, err := readCredentials(cfg.AccessKeyIDFile, cfg.SecretAccessKeyFile); err != nil {
		problems = append(problems, err)
	}

	if cfg.TLSCAFile != "" {
		if _, err := loadCAPool(cfg.TLSCAFile); err != nil {
			problems = append(problems, err)
		}
	}

	return errors.Join(problems...)
}

// fileCredentials reads S3 credentials from two files on every Retrieve.
type fileCredentials struct {
	accessKeyIDFile     string
	secretAccessKeyFile string
	lifetime            time.Duration
}

// Retrieve implements aws.CredentialsProvider. The credentials expire after
// the refresh interval, so the SDK's cache calls Retrieve, and the files are
// read, again.
func (provider fileCredentials) Retrieve(context.Context) (aws.Credentials, error) {
	credentials, err := readCredentials(provider.accessKeyIDFile, provider.secretAccessKeyFile)
	if err != nil {
		return aws.Credentials{}, err
	}

	credentials.CanExpire = true
	credentials.Expires = time.Now().Add(provider.lifetime)

	return credentials, nil
}

func readCredentials(accessKeyIDFile, secretAccessKeyFile string) (aws.Credentials, error) {
	accessKeyID, err := readSecretFile(accessKeyIDFile, "access key id")
	if err != nil {
		return aws.Credentials{}, err
	}

	secretAccessKey, err := readSecretFile(secretAccessKeyFile, "secret access key")
	if err != nil {
		return aws.Credentials{}, err
	}

	return aws.Credentials{AccessKeyID: accessKeyID, SecretAccessKey: secretAccessKey, Source: "vault-sync credential files"}, nil
}

// maxSecretFileBytes bounds a credential file.
const maxSecretFileBytes = 4 << 10

func readSecretFile(path, what string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("read S3 %s file: %w", what, err)
	}

	if info.Size() > maxSecretFileBytes {
		return "", fmt.Errorf("S3 %s file %q is larger than %d bytes", what, path, maxSecretFileBytes)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read S3 %s file: %w", what, err)
	}

	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("S3 %s file %q is empty", what, path)
	}

	return value, nil
}

// newClient builds an S3 client for cfg.
func newClient(cfg Config) *s3.Client {
	lifetime := cfg.CredentialsRefreshInterval
	if lifetime <= 0 {
		lifetime = DefaultCredentialsRefreshInterval
	}

	region := cfg.Region
	if region == "" {
		region = DefaultRegion
	}

	httpClient := awshttp.NewBuildableClient()

	if cfg.TLSCAFile != "" {
		caFile := cfg.TLSCAFile
		endpointHost := ""

		if cfg.Endpoint != "" {
			// Validate has already rejected unparsable endpoints.
			if parsed, err := url.Parse(cfg.Endpoint); err == nil {
				endpointHost = parsed.Hostname()
			}
		}

		httpClient = httpClient.WithTransportOptions(func(transport *http.Transport) {
			transport.TLSClientConfig = rotatingCATLSConfig(caFile, endpointHost)
		})
	}

	options := s3.Options{
		Region:       region,
		Credentials:  aws.NewCredentialsCache(fileCredentials{accessKeyIDFile: cfg.AccessKeyIDFile, secretAccessKeyFile: cfg.SecretAccessKeyFile, lifetime: lifetime}),
		UsePathStyle: cfg.ForcePathStyle,
		HTTPClient:   httpClient,
		HTTPSignerV4: &rotatingSigner{},
		// Only send and check checksums the API requires: several
		// S3-compatible stores reject the SDK's default extra checksums.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	}

	if cfg.Endpoint != "" {
		options.BaseEndpoint = aws.String(cfg.Endpoint)
	}

	return s3.New(options)
}

// rotatingSigner is the S3 SigV4 signer, replaced whenever the secret key
// changes. The SDK's signer caches the derived signing key by access key id
// and day, so on its own it would keep signing with a rotated-out secret
// until midnight UTC when only the secret is rotated.
type rotatingSigner struct {
	mutex  sync.Mutex
	secret string
	signer *v4.Signer
}

// SignHTTP implements s3.HTTPSignerV4.
func (rotating *rotatingSigner) SignHTTP(ctx context.Context, credentials aws.Credentials, request *http.Request, payloadHash, service, region string, signingTime time.Time, optFns ...func(*v4.SignerOptions)) error {
	rotating.mutex.Lock()

	if rotating.signer == nil || rotating.secret != credentials.SecretAccessKey {
		// The same options as the S3 client's default signer.
		rotating.signer = v4.NewSigner(func(options *v4.SignerOptions) { options.DisableURIPathEscaping = true })
		rotating.secret = credentials.SecretAccessKey
	}

	signer := rotating.signer
	rotating.mutex.Unlock()

	return signer.SignHTTP(ctx, credentials, request, payloadHash, service, region, signingTime, optFns...)
}

// rotatingCATLSConfig verifies the server certificate against caFile, read
// again for every handshake, and against the host being connected to.
// endpointHost is the configured endpoint's host (empty for AWS S3).
func rotatingCATLSConfig(caFile, endpointHost string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// The standard verification uses a fixed RootCAs pool, so it is
		// replaced by VerifyConnection, which re-reads the bundle and checks
		// both the chain and the host name.
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			return verifyEndpointCertificate(state, caFile, endpointHost)
		},
	}
}

// verifyEndpointCertificate checks the certificate chain against caFile and
// the leaf against the host the client dialed.
//
// For a host name, http.Transport sends it as SNI, and state.ServerName is
// that name (bucket.endpoint for virtual-hosted addressing). TLS never
// carries an IP address as SNI, so for an IP-literal endpoint ServerName is
// empty; x509 would then skip the host check entirely, so the configured
// endpoint IP is checked against the certificate's IP SANs instead.
func verifyEndpointCertificate(state tls.ConnectionState, caFile, endpointHost string) error {
	if len(state.PeerCertificates) == 0 {
		return errors.New("S3 endpoint presented no certificate")
	}

	host := state.ServerName
	if host == "" {
		host = endpointHost
	}

	if host == "" {
		return errors.New("verify S3 endpoint certificate: no host name to verify it against")
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
		return fmt.Errorf("verify S3 endpoint certificate: %w", err)
	}

	return nil
}

func loadCAPool(caFile string) (*x509.CertPool, error) {
	pemData, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read S3 CA file: %w", err)
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemData) {
		return nil, fmt.Errorf("S3 CA file %q contains no PEM certificates", caFile)
	}

	return pool, nil
}
