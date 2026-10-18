package server_test

import (
	"regexp"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
)

// The authorization interceptor (internal/authz) finds a request's vault
// through the top-level vault_id only, and vaultScopedProcedures classifies a
// procedure as vault-scoped by that field alone. A vault named anywhere else
// in a request would bypass both, so the schema must not contain one.
//
// The rule: in every RPC input message, a vault-identifying field may appear
// only as the single top-level field `string vault_id` that is singular and
// not a oneof member. A field is vault-identifying when
//
//   - its name, as a snake_case word sequence, ends in "vault", "vaults",
//     "vault_id", "vault_ids", "vaultid" or "vaultids" (for example vault_id,
//     target_vault_id, vault_ids, vault, parent_vault); or
//   - its type is a message named Vault (in any package).
//
// The walk covers nested messages, oneof members, repeated fields and map
// keys and values, and stops at a message type already on the current path,
// so recursive types terminate.

// vaultIdentifyingName matches the field names the rule treats as naming a
// vault.
var vaultIdentifyingName = regexp.MustCompile(`(^|_)vault(_?ids?|s)?$`)

// vaultMessageName is the name of the message type that describes a vault.
const vaultMessageName protoreflect.Name = "Vault"

// isVaultIdentifying reports whether field names or carries a vault.
func isVaultIdentifying(field protoreflect.FieldDescriptor) bool {
	if vaultIdentifyingName.MatchString(string(field.Name())) {
		return true
	}

	return field.Message() != nil && field.Message().Name() == vaultMessageName
}

// isTopLevelVaultID reports whether field is the one permitted
// vault-identifying field of a request: `string vault_id`, singular and not
// in a oneof.
func isTopLevelVaultID(field protoreflect.FieldDescriptor) bool {
	return field.Name() == "vault_id" &&
		field.Kind() == protoreflect.StringKind &&
		field.Cardinality() != protoreflect.Repeated &&
		field.ContainingOneof() == nil
}

// misplacedVaultFields returns the dotted path of every vault-identifying
// field in input other than the permitted top-level vault_id.
func misplacedVaultFields(input protoreflect.MessageDescriptor) []string {
	var misplaced []string

	var walk func(message protoreflect.MessageDescriptor, prefix string, ancestors []protoreflect.FullName)

	walk = func(message protoreflect.MessageDescriptor, prefix string, ancestors []protoreflect.FullName) {
		if slices.Contains(ancestors, message.FullName()) {
			return
		}

		ancestors = append(ancestors, message.FullName())

		fields := message.Fields()
		for index := range fields.Len() {
			field := fields.Get(index)
			path := prefix + string(field.Name())

			if isVaultIdentifying(field) {
				if prefix != "" || !isTopLevelVaultID(field) {
					misplaced = append(misplaced, path)
				}

				continue
			}

			if field.Message() != nil {
				// Map fields are repeated entry messages, so this also
				// walks map keys and values.
				walk(field.Message(), path+".", ancestors)
			}
		}
	}

	walk(input, "", nil)

	return misplaced
}

// TestRequestsNameTheirVaultOnlyAtTheTopLevel fails, naming the procedure and
// field path, when an RPC input message carries a vault-identifying field
// anywhere but the top-level vault_id.
func TestRequestsNameTheirVaultOnlyAtTheTopLevel(t *testing.T) {
	methods := 0

	protoregistry.GlobalFiles.RangeFilesByPackage("vaultsync.v1", func(file protoreflect.FileDescriptor) bool {
		for serviceIndex := range file.Services().Len() {
			service := file.Services().Get(serviceIndex)
			for methodIndex := range service.Methods().Len() {
				method := service.Methods().Get(methodIndex)
				procedure := "/" + string(service.FullName()) + "/" + string(method.Name())
				methods++

				for _, path := range misplacedVaultFields(method.Input()) {
					assert.Fail(t, "vault-identifying field outside the top-level vault_id",
						"%s: %s.%s; the authz interceptor only reads the top-level vault_id (SPEC.md §9.2)",
						procedure, method.Input().FullName(), path)
				}
			}
		}

		return true
	})

	require.NotZero(t, methods)
}

// TestMisplacedVaultFields proves the guard on synthetic request messages,
// so that its logic is tested without changing the real schema.
func TestMisplacedVaultFields(t *testing.T) {
	file := syntheticRequests(t)

	tests := []struct {
		message string
		want    []string
	}{
		{message: "Scoped"},
		{message: "Unscoped"},
		{message: "CreateLike"},
		{message: "Tree"},
		{message: "VaultNamedField", want: []string{"vault"}},
		{message: "NestedID", want: []string{"inner.vault_id"}},
		{message: "DeeplyNestedID", want: []string{"outer.inner.vault_id"}},
		{message: "OneofTopLevelID", want: []string{"vault_id"}},
		{message: "OneofNestedID", want: []string{"inner.vault_id"}},
		{message: "RepeatedNestedID", want: []string{"items.vault_id"}},
		{message: "MapValueID", want: []string{"by_name.value.vault_id"}},
		{message: "MapKeyID", want: []string{"by_vault_id"}},
		{message: "RecursiveID", want: []string{"root.vault_id"}},
		{message: "SecondID", want: []string{"target_vault_id"}},
		{message: "PluralIDs", want: []string{"vault_ids"}},
		{message: "VaultTyped", want: []string{"settings.parent"}},
		{message: "RepeatedTopLevelID", want: []string{"vault_id"}},
		{message: "BytesTopLevelID", want: []string{"vault_id"}},
	}

	for _, test := range tests {
		t.Run(test.message, func(t *testing.T) {
			message := file.Messages().ByName(protoreflect.Name(test.message))
			require.NotNil(t, message)

			assert.Equal(t, test.want, misplacedVaultFields(message))
		})
	}
}

// syntheticRequests builds a file of request messages that exercise every
// shape the guard must recognize.
func syntheticRequests(t *testing.T) protoreflect.FileDescriptor {
	t.Helper()

	const pkg = "guardtest.v1"

	scalar := func(name string, number int32, kind descriptorpb.FieldDescriptorProto_Type) *descriptorpb.FieldDescriptorProto {
		return &descriptorpb.FieldDescriptorProto{
			Name:     proto.String(name),
			JsonName: proto.String(name),
			Number:   proto.Int32(number),
			Label:    descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
			Type:     kind.Enum(),
		}
	}
	str := func(name string, number int32) *descriptorpb.FieldDescriptorProto {
		return scalar(name, number, descriptorpb.FieldDescriptorProto_TYPE_STRING)
	}
	message := func(name string, number int32, typeName string) *descriptorpb.FieldDescriptorProto {
		field := scalar(name, number, descriptorpb.FieldDescriptorProto_TYPE_MESSAGE)
		field.TypeName = proto.String("." + pkg + "." + typeName)

		return field
	}
	repeated := func(field *descriptorpb.FieldDescriptorProto) *descriptorpb.FieldDescriptorProto {
		field.Label = descriptorpb.FieldDescriptorProto_LABEL_REPEATED.Enum()

		return field
	}
	inOneof := func(field *descriptorpb.FieldDescriptorProto) *descriptorpb.FieldDescriptorProto {
		field.OneofIndex = proto.Int32(0)

		return field
	}
	mapEntry := func(name string, key, value *descriptorpb.FieldDescriptorProto) *descriptorpb.DescriptorProto {
		return &descriptorpb.DescriptorProto{
			Name:    proto.String(name),
			Field:   []*descriptorpb.FieldDescriptorProto{key, value},
			Options: &descriptorpb.MessageOptions{MapEntry: proto.Bool(true)},
		}
	}
	define := func(name string, fields ...*descriptorpb.FieldDescriptorProto) *descriptorpb.DescriptorProto {
		return &descriptorpb.DescriptorProto{Name: proto.String(name), Field: fields}
	}
	withOneof := func(message *descriptorpb.DescriptorProto) *descriptorpb.DescriptorProto {
		message.OneofDecl = []*descriptorpb.OneofDescriptorProto{{Name: proto.String("choice")}}

		return message
	}

	mapValue := define("MapValueID", str("vault_id", 1), repeated(message("by_name", 2, "MapValueID.ByNameEntry")))
	mapValue.NestedType = []*descriptorpb.DescriptorProto{
		mapEntry("ByNameEntry", str("key", 1), message("value", 2, "Inner")),
	}

	mapKey := define("MapKeyID", str("vault_id", 1), repeated(message("by_vault_id", 2, "MapKeyID.ByVaultIdEntry")))
	mapKey.NestedType = []*descriptorpb.DescriptorProto{
		mapEntry("ByVaultIdEntry", str("key", 1), str("value", 2)),
	}

	fileProto := &descriptorpb.FileDescriptorProto{
		Name:    proto.String("guardtest/v1/requests.proto"),
		Package: proto.String(pkg),
		Syntax:  proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{
			define("Vault", str("id", 1), str("name", 2)),
			define("Inner", str("vault_id", 1)),
			define("Outer", message("inner", 1, "Inner")),
			define("Settings", str("name", 1), str("encryption", 2)),
			define("Node", message("next", 1, "Node"), str("vault_id", 2)),

			define("Scoped", str("vault_id", 1), str("document_id", 2)),
			define("Unscoped", str("page_token", 1)),
			define("CreateLike", str("name", 1), message("settings", 2, "Settings")),
			define("Tree", str("name", 1), repeated(message("children", 2, "Tree"))),
			define("VaultNamedField", message("vault", 1, "Settings")),
			define("NestedID", str("vault_id", 1), message("inner", 2, "Inner")),
			define("DeeplyNestedID", str("vault_id", 1), message("outer", 2, "Outer")),
			withOneof(define("OneofTopLevelID", inOneof(str("vault_id", 1)), inOneof(str("document_id", 2)))),
			withOneof(define("OneofNestedID", str("vault_id", 1), inOneof(message("inner", 2, "Inner")), inOneof(str("other", 3)))),
			define("RepeatedNestedID", str("vault_id", 1), repeated(message("items", 2, "Inner"))),
			mapValue,
			mapKey,
			define("RecursiveID", str("vault_id", 1), message("root", 2, "Node")),
			define("SecondID", str("vault_id", 1), str("target_vault_id", 2)),
			define("PluralIDs", repeated(str("vault_ids", 1))),
			define("VaultSettings", message("parent", 1, "Vault")),
			define("VaultTyped", str("vault_id", 1), message("settings", 2, "VaultSettings")),
			define("RepeatedTopLevelID", repeated(str("vault_id", 1))),
			define("BytesTopLevelID", scalar("vault_id", 1, descriptorpb.FieldDescriptorProto_TYPE_BYTES)),
		},
	}

	file, err := protodesc.NewFile(fileProto, new(protoregistry.Files))
	require.NoError(t, err)

	return file
}
