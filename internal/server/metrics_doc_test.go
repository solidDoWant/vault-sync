package server

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/retention"
)

// This test lives in package server because the full set of registered
// collectors is not observable through /metrics: a vector metric without
// observed label values is omitted from the exposition.

type documentedMetric struct {
	kind   string
	labels []string
}

var descPattern = regexp.MustCompile(`^Desc\{fqName: "([^"]+)", .*variableLabels: \{([^}]*)\}\}$`)

// registeredMetrics returns the name, type and label names of every
// vault_sync_* metric the server registers.
func registeredMetrics(t *testing.T) map[string]documentedMetric {
	t.Helper()

	hub := realtime.NewHub(realtime.Options{})
	registered := map[string]documentedMetric{}

	for _, collector := range serverCollectors(hub, newRPCMetrics(), newConcurrencyMetrics(), retention.NewMetrics()) {
		var kind string

		// Gauge before Counter: a Gauge also satisfies the Counter interface.
		switch collector.(type) {
		case prometheus.Gauge, *prometheus.GaugeVec:
			kind = "gauge"
		case prometheus.Counter, *prometheus.CounterVec:
			kind = "counter"
		case prometheus.Histogram, *prometheus.HistogramVec:
			kind = "histogram"
		default:
			require.Failf(t, "unknown collector type", "%T", collector)
		}

		descs := make(chan *prometheus.Desc, 16)
		collector.Describe(descs)
		close(descs)

		for desc := range descs {
			match := descPattern.FindStringSubmatch(desc.String())
			require.NotNil(t, match, "unparseable descriptor %s", desc)

			labels := []string{}
			if match[2] != "" {
				labels = strings.Split(match[2], ",")
			}

			registered[match[1]] = documentedMetric{kind: kind, labels: labels}
		}
	}

	return registered
}

// documentedMetrics parses the Metrics table of docs/configuration.md. It
// fails if the section has a table row outside its one table.
func documentedMetrics(t *testing.T) map[string]documentedMetric {
	t.Helper()

	content, err := os.ReadFile("../../docs/configuration.md")
	require.NoError(t, err)

	lines := strings.Split(string(content), "\n")
	start := slices.Index(lines, "## Metrics")
	require.NotEqual(t, -1, start, "no Metrics section")

	section := lines[start+1:]
	if end := slices.IndexFunc(section, func(line string) bool { return strings.HasPrefix(line, "## ") }); end != -1 {
		section = section[:end]
	}

	header := slices.Index(section, "| Metric | Type | Labels | Meaning |")
	require.NotEqual(t, -1, header, "no Metrics table header")
	require.Greater(t, len(section), header+1)
	require.Equal(t, "|---|---|---|---|", section[header+1])

	documented := map[string]documentedMetric{}
	inTable := true

	for index, line := range section {
		if index <= header+1 {
			assert.False(t, strings.HasPrefix(line, "|") && index < header, "table row before the Metrics table: %q", line)

			continue
		}

		if !strings.HasPrefix(line, "|") {
			inTable = false

			continue
		}

		require.True(t, inTable, "table row outside the Metrics table (a blank line ends a Markdown table): %q", line)

		cells := strings.Split(strings.Trim(line, "|"), "|")
		require.GreaterOrEqual(t, len(cells), 4, "malformed row %q", line)

		name := strings.Trim(strings.TrimSpace(cells[0]), "`")
		labels := []string{}

		for label := range strings.SplitSeq(cells[2], ",") {
			if label = strings.Trim(strings.TrimSpace(label), "`"); label != "" {
				labels = append(labels, label)
			}
		}

		assert.NotContains(t, documented, name, "metric documented twice")
		documented[name] = documentedMetric{kind: strings.TrimSpace(cells[1]), labels: labels}
	}

	return documented
}

func TestMetricsTableMatchesRegisteredMetrics(t *testing.T) {
	registered := registeredMetrics(t)
	documented := documentedMetrics(t)

	for name := range registered {
		assert.Contains(t, documented, name, "registered metric missing from the Metrics table in docs/configuration.md")
	}

	for name, metric := range documented {
		expected, ok := registered[name]
		if !assert.True(t, ok, "documented metric %s is not registered", name) {
			continue
		}

		assert.Equal(t, expected.kind, metric.kind, "type of %s", name)
		assert.ElementsMatch(t, expected.labels, metric.labels, "labels of %s", name)
	}
}
