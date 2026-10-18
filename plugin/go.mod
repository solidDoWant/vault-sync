// Package plugin is an intentionally empty module. It fences the plugin/ npm
// project (and node_modules, which can ship incidental .go files) out of the
// root module's ./... package walk. It contains no Go code.
module github.com/solidDoWant/vault-sync/plugin

go 1.26.0
