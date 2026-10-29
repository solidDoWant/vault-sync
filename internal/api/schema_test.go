// Package api_test checks the shape of the v1 protocol schema (proto/vaultsync/v1)
// through the generated descriptors. The schema is the protocol contract that
// every later component builds on, so its required surface is pinned here.
package api_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	// Registers the vaultsync.v1 descriptors in protoregistry.GlobalFiles.
	_ "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
)

const protoPackage = "vaultsync.v1."

func findMessage(t *testing.T, name string) protoreflect.MessageDescriptor {
	t.Helper()

	descriptor, err := protoregistry.GlobalFiles.FindDescriptorByName(protoPackage + protoreflect.FullName(name))
	require.NoError(t, err, "message %s must exist", name)

	message, ok := descriptor.(protoreflect.MessageDescriptor)
	require.True(t, ok, "%s must be a message", name)

	return message
}

func findField(t *testing.T, message, field string) protoreflect.FieldDescriptor {
	t.Helper()

	descriptor := findMessage(t, message).Fields().ByName(protoreflect.Name(field))
	require.NotNil(t, descriptor, "field %s.%s must exist", message, field)

	return descriptor
}

func TestSchemaDefinesRequiredRPCs(t *testing.T) {
	tests := []struct {
		name    string
		service string
		method  string
	}{
		{name: "server info (unauthenticated)", service: "ServerInfoService", method: "GetServerInfo"},
		{name: "create vault", service: "VaultService", method: "CreateVault"},
		{name: "list vaults", service: "VaultService", method: "ListVaults"},
		{name: "register device", service: "DeviceService", method: "RegisterDevice"},
		{name: "list changes since seq", service: "SyncService", method: "ListChanges"},
		{name: "fetch revision", service: "SyncService", method: "GetRevision"},
		{name: "commit revision", service: "SyncService", method: "CommitRevision"},
		{name: "document history", service: "SyncService", method: "GetDocumentHistory"},
		{name: "begin blob upload", service: "BlobService", method: "BeginBlob"},
		{name: "append blob chunk", service: "BlobService", method: "PutBlobChunk"},
		{name: "commit blob upload", service: "BlobService", method: "CommitBlob"},
		{name: "download blob", service: "BlobService", method: "DownloadBlob"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor, err := protoregistry.GlobalFiles.FindDescriptorByName(protoPackage + protoreflect.FullName(test.service))
			require.NoError(t, err)

			service, ok := descriptor.(protoreflect.ServiceDescriptor)
			require.True(t, ok)

			method := service.Methods().ByName(protoreflect.Name(test.method))
			require.NotNil(t, method, "%s.%s must exist", test.service, test.method)
			assert.False(t, method.IsStreamingClient(), "browsers cannot client-stream over fetch (SPEC.md §4.1)")
		})
	}
}

func TestSchemaRequestFields(t *testing.T) {
	tests := []struct {
		name    string
		message string
		field   string
		kind    protoreflect.Kind
	}{
		{name: "server info reports server version", message: "GetServerInfoResponse", field: "version", kind: protoreflect.StringKind},
		{name: "server info reports protocol version", message: "GetServerInfoResponse", field: "protocol_version", kind: protoreflect.Uint32Kind},
		{name: "server info advertises the OIDC issuer", message: "GetServerInfoResponse", field: "oidc_issuer_url", kind: protoreflect.StringKind},
		{name: "server info advertises the plugin client id", message: "GetServerInfoResponse", field: "oidc_client_id", kind: protoreflect.StringKind},
		{name: "list changes takes a since seq", message: "ListChangesRequest", field: "since_seq", kind: protoreflect.Uint64Kind},
		{name: "list changes is paginated", message: "ListChangesRequest", field: "page_size", kind: protoreflect.Uint32Kind},
		{name: "list changes reports more pages", message: "ListChangesResponse", field: "has_more", kind: protoreflect.BoolKind},
		{name: "commit revision takes a base revision id", message: "CommitRevisionRequest", field: "base_rev_id", kind: protoreflect.StringKind},
		{name: "commit revision takes a content reference", message: "CommitRevisionRequest", field: "content_ref", kind: protoreflect.MessageKind},
		{name: "commit revision takes a tombstone flag", message: "CommitRevisionRequest", field: "deleted", kind: protoreflect.BoolKind},
		{name: "revision carries its content reference", message: "Revision", field: "content_ref", kind: protoreflect.MessageKind},
		{name: "revision carries its seq", message: "Revision", field: "seq", kind: protoreflect.Uint64Kind},
		{name: "blob chunk carries an offset", message: "PutBlobChunkRequest", field: "offset", kind: protoreflect.Uint64Kind},
		{name: "blob download is ranged (offset)", message: "DownloadBlobRequest", field: "offset", kind: protoreflect.Uint64Kind},
		{name: "blob download is ranged (length)", message: "DownloadBlobRequest", field: "length", kind: protoreflect.Uint32Kind},
		{name: "history is paginated", message: "GetDocumentHistoryRequest", field: "page_token", kind: protoreflect.StringKind},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.kind, findField(t, test.message, test.field).Kind())
		})
	}
}

func TestSchemaIdentifiersAreStrings(t *testing.T) {
	tests := []struct {
		message string
		field   string
	}{
		{message: "Vault", field: "id"},
		{message: "Device", field: "id"},
		{message: "Document", field: "id"},
		{message: "Revision", field: "id"},
		{message: "Revision", field: "document_id"},
		{message: "Revision", field: "vault_id"},
		{message: "Revision", field: "parent_rev_id"},
		{message: "Revision", field: "device_id"},
		{message: "VaultChanged", field: "vault_id"},
	}

	for _, test := range tests {
		t.Run(test.message+"."+test.field, func(t *testing.T) {
			assert.Equal(t, protoreflect.StringKind, findField(t, test.message, test.field).Kind())
		})
	}
}

func TestSchemaEveryDocumentCarriesKind(t *testing.T) {
	descriptor, err := protoregistry.GlobalFiles.FindDescriptorByName(protoPackage + "DocumentKind")
	require.NoError(t, err)

	kind, ok := descriptor.(protoreflect.EnumDescriptor)
	require.True(t, ok)

	for _, value := range []protoreflect.Name{"DOCUMENT_KIND_BLOB", "DOCUMENT_KIND_TEXT", "DOCUMENT_KIND_YJS", "DOCUMENT_KIND_FOLDER"} {
		assert.NotNil(t, kind.Values().ByName(value), "DocumentKind must define %s", value)
	}

	for _, message := range []string{"Document", "Revision", "CommitRevisionRequest"} {
		t.Run(message, func(t *testing.T) {
			field := findField(t, message, "kind")
			require.Equal(t, protoreflect.EnumKind, field.Kind())
			assert.Equal(t, kind.FullName(), field.Enum().FullName())
		})
	}
}

// GetServerInfo is the one procedure an unauthenticated caller reaches
// (SPEC.md §9.1), so every field of its response must be public by design.
// The full field set is pinned here by hand, so adding a field, even one not
// yet populated, fails `make test` until it is reviewed and listed. Keep
// publicServerInfoFields in cmd/vault-sync-server/server_info_integration_test.go
// in step.
func TestSchemaServerInfoResponseHasOnlyPublicFields(t *testing.T) {
	// The escrow fields are the escrow public key (never its private key),
	// its id and the escrow default (SPEC.md §9.4).
	public := []string{"version", "protocol_version", "max_realtime_subscriptions", "oidc_issuer_url", "oidc_client_id", "escrow_public_key", "escrow_key_id", "escrow_default"}

	fields := findMessage(t, "GetServerInfoResponse").Fields()

	names := make([]string, 0, fields.Len())
	for index := range fields.Len() {
		names = append(names, string(fields.Get(index).Name()))
	}

	assert.ElementsMatch(t, public, names, "GetServerInfoResponse is returned without authentication; list a new field here only if it is public")
}

// Encrypted-capable fields must be bytes so that E2EE vaults (SPEC.md §9.3) can
// carry ciphertext / HMAC values without a breaking schema change.
func TestSchemaEncryptedCapableFieldsAreBytes(t *testing.T) {
	tests := []struct {
		message string
		field   string
	}{
		{message: "Revision", field: "path"},
		{message: "CommitRevisionRequest", field: "path"},
		{message: "CommitRevisionRequest", field: "path_key"},
		{message: "ContentRef", field: "blob_id"},
		{message: "BeginBlobRequest", field: "blob_id"},
		{message: "PutBlobChunkRequest", field: "blob_id"},
		{message: "PutBlobChunkRequest", field: "data"},
		{message: "CommitBlobRequest", field: "blob_id"},
		{message: "DownloadBlobRequest", field: "blob_id"},
		{message: "DownloadBlobResponse", field: "data"},
	}

	for _, test := range tests {
		t.Run(test.message+"."+test.field, func(t *testing.T) {
			assert.Equal(t, protoreflect.BytesKind, findField(t, test.message, test.field).Kind())
		})
	}
}

func TestSchemaRealtimeFrameEnvelopes(t *testing.T) {
	tests := []struct {
		name     string
		envelope string
		members  []string
	}{
		{name: "client to server", envelope: "ClientFrame", members: []string{"subscribe", "unsubscribe"}},
		{name: "server to client", envelope: "ServerFrame", members: []string{"vault_changed", "subscribed", "error"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			envelope := findMessage(t, test.envelope)

			oneof := envelope.Oneofs().ByName("frame")
			require.NotNil(t, oneof, "%s must have a frame oneof", test.envelope)

			for _, member := range test.members {
				field := oneof.Fields().ByName(protoreflect.Name(member))
				assert.NotNil(t, field, "%s.frame must contain %s", test.envelope, member)
			}

			// Field numbers 100-199 are reserved for Phase 5 Yjs update/awareness frames.
			ranges := envelope.ReservedRanges()
			reserved := false

			for index := range ranges.Len() {
				if ranges.Get(index) == [2]protoreflect.FieldNumber{100, 200} {
					reserved = true
				}
			}

			assert.True(t, reserved, "%s must reserve field numbers 100 to 199", test.envelope)
		})
	}

	t.Run("vault_changed carries vault id and seq", func(t *testing.T) {
		assert.Equal(t, protoreflect.StringKind, findField(t, "VaultChanged", "vault_id").Kind())
		assert.Equal(t, protoreflect.Uint64Kind, findField(t, "VaultChanged", "seq").Kind())
	})
}
