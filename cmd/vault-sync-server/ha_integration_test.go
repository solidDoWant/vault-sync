//go:build integration

package main_test

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
)

// Criterion 1: consecutive requests of one client, including the chunks of
// one blob upload and its commit, may land on different instances and
// behave as they would against a single instance.
func TestConsecutiveRequestsMayLandOnDifferentInstances(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)

	first := cluster.start(t, "first", binary)
	second := cluster.start(t, "second", binary)

	token := cluster.token(t, "alice")

	vault := createVault(t, first, token, "Notes")
	assert.Contains(t, listVaultIDs(t, second, token), vault.GetId(), "a vault created on one instance is listed by another")

	content, blobID := randomBlob(t, blobstore.PartSize+5*config.DefaultBlobMaxChunkBytes+123)
	client := &blobClient{token: token, vaultID: vault.GetId(), blobID: blobID, content: content}

	begun, err := client.begin(t, second)
	require.NoError(t, err)
	require.False(t, begun.GetComplete())
	require.Zero(t, begun.GetReceivedSize())

	// The upload is interrupted part-way and resumed through the other
	// instance, which knows how much the first one received.
	received := client.sendChunks(t, 0, 4, first, second)

	resumed, err := client.begin(t, first)
	require.NoError(t, err)
	require.Equal(t, uint64(received), resumed.GetReceivedSize())

	client.sendChunks(t, received, 0, second, first)

	committed, err := client.commit(t, first)
	require.NoError(t, err)
	assert.Equal(t, uint64(len(content)), committed.GetSize())

	client.requireStored(t, second, first)

	// A second commit, on the other instance, is a no-op success.
	_, err = client.commit(t, second)
	require.NoError(t, err)
}

// startChunkRequest sends the headers and half the body of client's chunk at
// offset to server, and returns once the server's handler is reading the
// body: the request is then in flight.
func startChunkRequest(t *testing.T, server *instance, client *blobClient, offset int) net.Conn {
	t.Helper()

	body, err := proto.Marshal(client.chunk(offset))
	require.NoError(t, err)

	address, err := url.Parse(server.apiURL)
	require.NoError(t, err)

	conn, err := net.Dial("tcp", address.Host)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	_, err = fmt.Fprintf(conn, "POST /vaultsync.v1.BlobService/PutBlobChunk HTTP/1.1\r\nHost: vault-sync\r\n"+
		"Authorization: Bearer %s\r\nContent-Type: application/proto\r\nContent-Length: %d\r\nExpect: 100-continue\r\n\r\n",
		client.token, len(body))
	require.NoError(t, err)

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(30*time.Second)))

	reader := bufio.NewReader(conn)

	status, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "HTTP/1.1 100 Continue\r\n", status)

	_, err = conn.Write(body[:len(body)/2])
	require.NoError(t, err)

	return conn
}

func multipartUploads(t *testing.T, objects *blobstore.Objects) int {
	t.Helper()

	listed, err := objects.Client().ListMultipartUploads(t.Context(), &s3.ListMultipartUploadsInput{
		Bucket: aws.String(objects.Bucket()),
	})
	require.NoError(t, err)

	return len(listed.Uploads)
}

func objectKeys(t *testing.T, objects *blobstore.Objects, prefix string) []string {
	t.Helper()

	listed, err := objects.Client().ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{
		Bucket: aws.String(objects.Bucket()),
		Prefix: aws.String(prefix),
	})
	require.NoError(t, err)

	keys := make([]string, 0, len(listed.Contents))
	for _, object := range listed.Contents {
		keys = append(keys, aws.ToString(object.Key))
	}

	return keys
}

// Criterion 3: an instance killed without warning (SIGKILL) in the middle of
// a request, whether it is receiving a chunk or composing a commit, leaves
// a state from which the client's retry on another instance succeeds;
// chunks acknowledged before the kill are kept, and the blob is stored
// exactly once.
func TestRetryOnAnotherInstanceAfterSIGKILLMidRequest(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)

	chunkVictim := cluster.start(t, "chunk-victim", binary)
	commitVictim := cluster.start(t, "commit-victim", binary)
	survivor := cluster.start(t, "survivor", binary)

	objects, err := blobstore.New(cluster.objects)
	require.NoError(t, err)

	token := cluster.token(t, "alice")
	vault := createVault(t, chunkVictim, token, "Notes")

	// Several multipart parts, so the commit runs long enough to be killed
	// part-way.
	content, blobID := randomBlob(t, 6*blobstore.PartSize+4321)
	client := &blobClient{token: token, vaultID: vault.GetId(), blobID: blobID, content: content}

	_, err = client.begin(t, chunkVictim)
	require.NoError(t, err)

	acknowledged := client.sendChunks(t, 0, 5, chunkVictim, commitVictim)

	// Killed while receiving a chunk.
	conn := startChunkRequest(t, chunkVictim, client, acknowledged)
	chunkVictim.kill(t)

	_, err = bufio.NewReader(conn).ReadByte()
	require.Error(t, err, "the killed instance never answers")

	// The retry goes to another instance, which still has every
	// acknowledged chunk and accepts the one that was in flight.
	resumed, err := client.begin(t, commitVictim)
	require.NoError(t, err)
	require.Equal(t, uint64(acknowledged), resumed.GetReceivedSize(), "acknowledged chunks must survive the kill")

	client.sendChunks(t, acknowledged, 0, commitVictim, survivor)

	// Killed while composing the commit: once its multipart upload exists.
	var (
		group     sync.WaitGroup
		commitErr error
	)

	group.Go(func() { _, commitErr = client.commit(t, commitVictim) })

	require.Eventually(t, func() bool { return multipartUploads(t, objects) > 0 }, time.Minute, time.Millisecond,
		"the commit must start composing")
	commitVictim.kill(t)
	group.Wait()

	require.Error(t, commitErr, "the commit was killed before it finished")

	committed, err := client.commit(t, survivor)
	require.NoError(t, err, "the retried commit succeeds on another instance")
	assert.Equal(t, uint64(len(content)), committed.GetSize())

	client.requireStored(t, survivor)

	vaultID := uuid.MustParse(vault.GetId())
	assert.Equal(t, []string{blobstore.BlobKey(vaultID, blobID)}, objectKeys(t, objects, blobstore.VaultPrefix(vaultID)+"blobs/"),
		"the blob is stored exactly once")
	assert.Empty(t, objectKeys(t, objects, blobstore.VaultPrefix(vaultID)+"uploads/"), "staged chunks are removed")
}

// Criterion 2: on SIGTERM an instance fails /readyz while it still serves
// the API, so a load balancer moves its traffic away before any request is
// refused; it then finishes in-flight requests and exits 0. A client
// alternating between it and another instance sees no failed request.
func TestSIGTERMHasNoClientVisibleImpact(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)

	const shutdownDelay = 2 * time.Second

	draining := cluster.start(t, "draining", binary, config.ShutdownDelayEnv+"="+shutdownDelay.String())
	other := cluster.start(t, "other", binary)

	token := cluster.token(t, "alice")
	vault := createVault(t, draining, token, "Notes")

	content, blobID := randomBlob(t, 40*config.DefaultBlobMaxChunkBytes)
	client := &blobClient{token: token, vaultID: vault.GetId(), blobID: blobID, content: content}

	_, err := client.begin(t, draining)
	require.NoError(t, err)

	received := client.sendChunks(t, 0, 2, draining, other)

	require.NoError(t, draining.process.Command.Process.Signal(syscall.SIGTERM))

	// A load balancer stops routing to the instance once /readyz fails;
	// until then requests to it still succeed.
	for {
		status, err := httpGet("http://" + draining.metricsAddress + "/readyz")
		if err != nil || status != http.StatusOK {
			break
		}

		received = client.sendChunks(t, received, 1, draining)
	}

	// Requests a load balancer routed before it noticed still succeed:
	// the API keeps serving after readiness fails.
	received = client.sendChunks(t, received, 1, draining)

	// Ready instances only from here on, as a load balancer would route.
	client.sendChunks(t, received, 0, other)

	_, err = client.commit(t, other)
	require.NoError(t, err)

	select {
	case <-draining.process.Exited():
		require.NoError(t, draining.process.Err(), "a drained instance exits 0")
	case <-time.After(30 * time.Second):
		t.Fatal("the instance did not exit after draining")
	}

	client.requireStored(t, other)
}
