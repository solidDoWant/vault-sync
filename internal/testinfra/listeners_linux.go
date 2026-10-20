package testinfra

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
)

// tcpListenState is the st column of a listening socket in /proc/net/tcp.
const tcpListenState = "0A"

// listensOn reports whether the process with pid holds a TCP socket
// listening on address, an IPv4 host:port. It reads the process's open file
// descriptors and the kernel's socket table, so it cannot be fooled by
// another process serving on the port; it returns false when either cannot
// be read, e.g. because the process has exited.
func listensOn(pid int, address string) bool {
	addrPort, err := netip.ParseAddrPort(address)
	if err != nil || !addrPort.Addr().Is4() {
		return false
	}

	inodes, err := socketInodes(pid)
	if err != nil || len(inodes) == 0 {
		return false
	}

	table, err := os.Open(fmt.Sprintf("/proc/%d/net/tcp", pid))
	if err != nil {
		return false
	}

	defer func() { _ = table.Close() }()

	local := procTCPAddress(addrPort)
	scanner := bufio.NewScanner(table)

	for scanner.Scan() {
		// sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode ...
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || fields[1] != local || fields[3] != tcpListenState {
			continue
		}

		if _, ours := inodes[fields[9]]; ours {
			return true
		}
	}

	return false
}

// socketInodes returns the inodes of the sockets the process with pid has
// open.
func socketInodes(pid int) (map[string]struct{}, error) {
	directory := fmt.Sprintf("/proc/%d/fd", pid)

	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}

	inodes := map[string]struct{}{}

	for _, entry := range entries {
		target, err := os.Readlink(filepath.Join(directory, entry.Name()))
		if err != nil {
			// Closed meanwhile.
			continue
		}

		if inode, ok := strings.CutPrefix(target, "socket:["); ok {
			inodes[strings.TrimSuffix(inode, "]")] = struct{}{}
		}
	}

	return inodes, nil
}

// procTCPAddress formats an IPv4 address as /proc/net/tcp does: the
// network-order address read as a native-endian 32-bit number, in hex, then
// the port in hex.
func procTCPAddress(addrPort netip.AddrPort) string {
	octets := addrPort.Addr().As4()

	return fmt.Sprintf("%08X:%04X", binary.NativeEndian.Uint32(octets[:]), addrPort.Port())
}
