package vaultimport_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

func manifestDocument(path, kind, status string) export.ManifestDocument {
	return export.ManifestDocument{Type: export.ManifestTypeDocument, DocumentID: uuid.New(), Path: path, Kind: kind, Status: status}
}

// plannedPaths maps each planned file's document id to its path, and
// lists the planned folders in order.
func plannedPaths(t *testing.T, plan []vaultimport.PlannedDocument) (map[uuid.UUID]string, []string) {
	t.Helper()

	files := map[uuid.UUID]string{}

	var folders []string

	created := map[string]bool{}

	for _, planned := range plan {
		if planned.Document == nil {
			assert.Equal(t, vaultimport.KindFolder, planned.Kind)

			folders = append(folders, planned.Path)
			created[planned.Path] = true

			continue
		}

		for index := range len(planned.Path) {
			if planned.Path[index] == '/' {
				assert.True(t, created[planned.Path[:index]], "the folder of %q is created before it", planned.Path)
			}
		}

		files[planned.Document.DocumentID] = planned.Path
	}

	return files, folders
}

func TestPlanKeepsPlacedPathsAndCreatesFoldersFirst(t *testing.T) {
	note := manifestDocument("a/b/note.md", "text", export.ManifestPlaced)
	image := manifestDocument("a/image.png", "blob", export.ManifestPlaced)

	plan := vaultimport.Plan([]export.ManifestDocument{note, image})
	files, folders := plannedPaths(t, plan)

	assert.Equal(t, map[uuid.UUID]string{note.DocumentID: "a/b/note.md", image.DocumentID: "a/image.png"}, files)
	assert.Equal(t, []string{"a", "a/b"}, folders)

	for _, planned := range plan {
		assert.False(t, planned.Fallback)
	}
}

func TestPlanSendsCollisionsToTheFallback(t *testing.T) {
	// The unplaced document comes first in the manifest, but placed
	// documents keep their paths first.
	unplaced := manifestDocument("Note.md", "text", export.ManifestUnplaced)
	placed := manifestDocument("note.md", "text", export.ManifestPlaced)
	file := manifestDocument("x", "blob", export.ManifestPlaced)
	underFile := manifestDocument("x/y.png", "blob", export.ManifestUnplaced)
	folderOwner := manifestDocument("z/w.md", "text", export.ManifestPlaced)
	fileOverFolder := manifestDocument("Z", "blob", export.ManifestUnplaced)

	plan := vaultimport.Plan([]export.ManifestDocument{unplaced, placed, file, underFile, folderOwner, fileOverFolder})
	files, _ := plannedPaths(t, plan)

	assert.Equal(t, "note.md", files[placed.DocumentID])
	assert.Equal(t, "x", files[file.DocumentID])
	assert.Equal(t, "z/w.md", files[folderOwner.DocumentID])
	assert.Equal(t, "Restored files/"+unplaced.DocumentID.String()+".md", files[unplaced.DocumentID])
	assert.Equal(t, "Restored files/"+underFile.DocumentID.String()+".png", files[underFile.DocumentID])
	assert.Equal(t, "Restored files/"+fileOverFolder.DocumentID.String(), files[fileOverFolder.DocumentID])

	fallback := map[uuid.UUID]bool{}

	for _, planned := range plan {
		if planned.Document != nil {
			fallback[planned.Document.DocumentID] = planned.Fallback
		}
	}

	assert.Equal(t, map[uuid.UUID]bool{
		unplaced.DocumentID: true, placed.DocumentID: false, file.DocumentID: false,
		underFile.DocumentID: true, folderOwner.DocumentID: false, fileOverFolder.DocumentID: true,
	}, fallback)
}

func TestPlanFallbackNames(t *testing.T) {
	for _, test := range []struct {
		name     string
		document export.ManifestDocument
		suffix   string
	}{
		{name: "an empty text path ends in .md", document: manifestDocument("", "text", export.ManifestUnplaced), suffix: ".md"},
		{name: "an empty blob path has no extension", document: manifestDocument("", "blob", export.ManifestUnplaced), suffix: ""},
		{name: "a refused path keeps a portable extension", document: manifestDocument("a?b.pdf", "blob", export.ManifestUnplaced), suffix: ".pdf"},
		{name: "an unportable extension is dropped", document: manifestDocument("a.p?f", "blob", export.ManifestUnplaced), suffix: ""},
		{name: "a text document always ends in .md", document: manifestDocument("a?b.MD", "text", export.ManifestUnplaced), suffix: ".md"},
		{name: "a non-UTF-8 path is not kept", document: export.ManifestDocument{
			DocumentID: uuid.New(), Path: "ok.png", PathBase64: "b2v/LnBuZw==", Kind: "blob", Status: export.ManifestUnplaced,
		}, suffix: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			files, folders := plannedPaths(t, vaultimport.Plan([]export.ManifestDocument{test.document}))

			assert.Equal(t, "Restored files/"+test.document.DocumentID.String()+test.suffix, files[test.document.DocumentID])
			assert.Equal(t, []string{"Restored files"}, folders)
		})
	}
}

func TestPlanSkipsARestoredFilesNameATakenFileUses(t *testing.T) {
	taken := manifestDocument("restored files", "blob", export.ManifestPlaced)
	alsoTaken := manifestDocument("Restored files 2", "blob", export.ManifestPlaced)
	inFolder := manifestDocument("Restored files 3/keep.md", "text", export.ManifestPlaced)
	refused := manifestDocument("", "text", export.ManifestUnplaced)

	files, _ := plannedPaths(t, vaultimport.Plan([]export.ManifestDocument{taken, alsoTaken, inFolder, refused}))

	require.Len(t, files, 4)
	assert.Equal(t, "restored files", files[taken.DocumentID])
	assert.Equal(t, "Restored files 3/"+refused.DocumentID.String()+".md", files[refused.DocumentID])
}

func TestPlanLeavesNoTwoFilesOnOneKey(t *testing.T) {
	documents := []export.ManifestDocument{
		manifestDocument("A.md", "text", export.ManifestPlaced),
		manifestDocument("a.md", "text", export.ManifestPlaced),
		manifestDocument("a.md", "text", export.ManifestUnplaced),
		manifestDocument("Café.md", "text", export.ManifestUnplaced),
		manifestDocument("café.md", "text", export.ManifestUnplaced),
	}

	files, _ := plannedPaths(t, vaultimport.Plan(documents))
	require.Len(t, files, len(documents))

	assert.Equal(t, "A.md", files[documents[0].DocumentID])
	assert.Equal(t, "Café.md", files[documents[3].DocumentID])

	for _, index := range []int{1, 2, 4} {
		assert.Equal(t, "Restored files/"+documents[index].DocumentID.String()+".md", files[documents[index].DocumentID])
	}
}
