package realtime

// SetMembershipBatch sets the users checked per membership query before a
// delivery and returns a function restoring the previous value. Tests that
// call it must not run in parallel.
func SetMembershipBatch(size int) func() {
	previous := membershipBatch
	membershipBatch = size

	return func() { membershipBatch = previous }
}
