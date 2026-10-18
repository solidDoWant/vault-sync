-- Resumable blob upload sessions (SPEC.md §5, §6.2).
--
-- A session collects the chunks of one blob as staged S3 objects under
-- vaults/{vault_id}/uploads/{id}/ until CommitBlob composes them into the
-- blob's object. The blobs row is only inserted, as 'complete', once the
-- composed object is in place, so upload progress lives here and blob
-- existence lives in blobs.

CREATE TABLE blob_uploads (
    -- Names the session's staged-object prefix. A new session (after a
    -- failed hash or an expired one) gets a new id, so its objects can never
    -- be confused with a discarded session's.
    id             uuid        PRIMARY KEY,
    vault_id       uuid        NOT NULL REFERENCES vaults (id),
    blob_id        bytea       NOT NULL CONSTRAINT blob_uploads_blob_id_length CHECK (octet_length(blob_id) = 32),
    -- Declared total size.
    size           bigint      NOT NULL CONSTRAINT blob_uploads_size_nonnegative CHECK (size >= 0),
    -- Bytes accepted so far: the next chunk's offset.
    received_size  bigint      NOT NULL DEFAULT 0,
    -- 'uploading' accepts chunks and commits; 'finished' (committed,
    -- discarded or expired) only awaits removal of its staged objects.
    state          text        NOT NULL DEFAULT 'uploading' CONSTRAINT blob_uploads_state_valid CHECK (state IN ('uploading', 'finished')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- Last activity; sessions idle for longer than the upload TTL are reaped.
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT blob_uploads_received_size_valid CHECK (received_size BETWEEN 0 AND size)
);

-- At most one active session per blob: concurrent uploaders of the same blob
-- share it and append strictly sequentially.
CREATE UNIQUE INDEX blob_uploads_active_blob_idx ON blob_uploads (vault_id, blob_id) WHERE state = 'uploading';

CREATE INDEX blob_uploads_updated_at_idx ON blob_uploads (updated_at);

-- Accepted chunks of a session, in offset order. Each chunk is a staged
-- object whose key ends in "offset-token", so a writer that lost the race for
-- an offset can never overwrite the accepted chunk.
CREATE TABLE blob_upload_chunks (
    upload_id   uuid    NOT NULL REFERENCES blob_uploads (id) ON DELETE CASCADE,
    vault_id    uuid    NOT NULL REFERENCES vaults (id),
    "offset"    bigint  NOT NULL CONSTRAINT blob_upload_chunks_offset_nonnegative CHECK ("offset" >= 0),
    length      integer NOT NULL CONSTRAINT blob_upload_chunks_length_positive CHECK (length > 0),
    token       uuid    NOT NULL,
    PRIMARY KEY (upload_id, "offset")
);
