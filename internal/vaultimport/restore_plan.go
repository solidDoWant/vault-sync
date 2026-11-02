package vaultimport

import (
	"path"
	"strconv"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

// RestoredFilesFolder is the folder a restore puts a document in when it
// cannot keep the document's own path (docs/design/restore-from-export.md
// §4). When a planned file already takes that name, the next free name of
// "Restored files 2", "Restored files 3" and so on is used.
const RestoredFilesFolder = "Restored files"

// PlannedDocument is one document a restore creates, with its target path.
type PlannedDocument struct {
	// Document is the manifest line; nil for a folder the plan adds.
	Document *export.ManifestDocument
	// Path is the target path in the new vault.
	Path string
	Kind Kind
	// Fallback is true when the document could not keep its own path.
	Fallback bool
}

// pathSet holds the path keys a plan has chosen, as files and as the
// folders that hold them.
type pathSet struct {
	files   map[string]bool
	folders map[string]bool
}

func newPathSet() *pathSet {
	return &pathSet{files: map[string]bool{}, folders: map[string]bool{}}
}

// free reports whether target may be added as a file: its key is not
// already a file or a folder, and none of its folders is a file.
func (set *pathSet) free(target string) bool {
	key := pathkey.Key(target)
	if set.files[key] || set.folders[key] {
		return false
	}

	for _, folder := range ancestors(key) {
		if set.files[folder] {
			return false
		}
	}

	return true
}

func (set *pathSet) add(target string) {
	key := pathkey.Key(target)
	set.files[key] = true

	for _, folder := range ancestors(key) {
		set.folders[folder] = true
	}
}

// ancestors returns the folders of a slash-separated path, outermost
// first.
func ancestors(target string) []string {
	var folders []string

	for index := 0; index < len(target); index++ {
		if target[index] == '/' {
			folders = append(folders, target[:index])
		}
	}

	return folders
}

// Plan decides the target path of every document before anything is
// created (docs/design/restore-from-export.md §4). documents are the
// manifest lines to restore (placed and unplaced, in manifest order).
// Placed documents come first, then unplaced ones. A document keeps its
// path when the server's path rules accept it and it collides with no
// path already chosen; otherwise it goes to the restored-files folder.
// The result has a FOLDER document before the files of every folder.
func Plan(documents []export.ManifestDocument) []PlannedDocument {
	ordered := make([]*export.ManifestDocument, 0, len(documents))

	for _, status := range []string{export.ManifestPlaced, export.ManifestUnplaced} {
		for index := range documents {
			if documents[index].Status == status {
				ordered = append(ordered, &documents[index])
			}
		}
	}

	chosen := newPathSet()
	files := make([]PlannedDocument, 0, len(ordered))

	var fallbacks []int

	for _, document := range ordered {
		planned := PlannedDocument{Document: document, Kind: Kind(document.Kind), Path: document.Path}

		if document.Path != "" && document.PathBase64 == "" && checkPortable(document.Path) == nil && chosen.free(document.Path) {
			chosen.add(document.Path)
		} else {
			planned.Fallback = true

			fallbacks = append(fallbacks, len(files))
		}

		files = append(files, planned)
	}

	if len(fallbacks) > 0 {
		placeFallbacks(files, fallbacks, chosen)
	}

	return withFolders(files)
}

// placeFallbacks gives each document in files at the indexes fallbacks a
// path in the first restored-files folder where every one of them is
// free.
func placeFallbacks(files []PlannedDocument, fallbacks []int, chosen *pathSet) {
	for number := 1; ; number++ {
		folder := RestoredFilesFolder
		if number > 1 {
			folder += " " + strconv.Itoa(number)
		}

		trial := &pathSet{files: copyKeys(chosen.files), folders: copyKeys(chosen.folders)}
		targets := make([]string, 0, len(fallbacks))
		fits := !trial.files[pathkey.Key(folder)]

		for _, index := range fallbacks {
			if !fits {
				break
			}

			target := FallbackPath(folder, *files[index].Document)
			if !trial.free(target) {
				fits = false

				break
			}

			trial.add(target)
			targets = append(targets, target)
		}

		if !fits {
			continue
		}

		for position, index := range fallbacks {
			files[index].Path = targets[position]
		}

		*chosen = *trial

		return
	}
}

func copyKeys(source map[string]bool) map[string]bool {
	copied := make(map[string]bool, len(source))
	for key, value := range source {
		copied[key] = value
	}

	return copied
}

// FallbackPath returns the path of document in the restored-files folder
// folder: the document id, with the extension of its original name when
// the whole path passes the server's rules. A text document always ends
// in ".md".
func FallbackPath(folder string, document export.ManifestDocument) string {
	base := folder + "/" + document.DocumentID.String()

	extension := ""
	if document.Path != "" && document.PathBase64 == "" {
		extension = path.Ext(path.Base(document.Path))
	}

	if extension != "" && checkPortable(base+extension) != nil {
		extension = ""
	}

	if Kind(document.Kind) == KindText && extension != ".md" {
		extension = ".md"
	}

	return base + extension
}

// withFolders returns files with a FOLDER document before the first file
// of each folder.
func withFolders(files []PlannedDocument) []PlannedDocument {
	result := make([]PlannedDocument, 0, len(files))
	created := map[string]bool{}

	for _, file := range files {
		for _, folder := range ancestors(file.Path) {
			if key := pathkey.Key(folder); !created[key] {
				created[key] = true

				result = append(result, PlannedDocument{Path: folder, Kind: KindFolder})
			}
		}

		result = append(result, file)
	}

	return result
}

// documentLabel names a planned document in logs and errors without its
// path: the document id, or "a folder" for a folder the plan added.
func documentLabel(planned PlannedDocument) string {
	if planned.Document == nil {
		return "a folder"
	}

	return planned.Document.DocumentID.String()
}
