// The sync round keeps what its overwrites and removes expect (RoundKept):
// each content the pass overwrites or removes lies on its document's G6
// chain (RoundChain, and so ReadKept) or is a live accepted revision
// (PassKept), which gives G2_OnlyWhatItSaw of the round.
include "RoundWhatItSaw.dfy"

abstract module RoundKeeps refines RoundWhatItSaw {

  // ---------------------------------------------------------------------
  // G2 of the round: contents a chain passes through
  // ---------------------------------------------------------------------

  // A chain that holds with a content holds with none.
  lemma ChainSavedNone(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                       x: Option<(Hash, Kind)>, c: Option<Hash>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c)
    ensures ChainSaved(saved, d, b, bd, l, rs, x, None)
    decreases |rs|, if l.Some? then 1 else 0
  {
    var lg := if c == LocalContent(l) then None else c;
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, lg) {
      ChainSavedNone(saved, d, b, bd, None, rs, x, lg);
      return;
    }
    if |rs| > 0 {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None))); y;
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c) {
        ChainSavedNone(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c);
      }
    }
  }

  // The local side a chain leaves is one of its contents.
  lemma ChainSavedHere(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                       x: Option<(Hash, Kind)>, c: Option<Hash>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c)
    ensures ChainSaved(saved, d, b, bd, l, rs, x, LocalContent(x))
    decreases |rs|, if l.Some? then 1 else 0
  {
    var lg := if c == LocalContent(l) then None else c;
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, lg) {
      ChainSavedHere(saved, d, b, bd, None, rs, x, lg);
      if LocalContent(x) == LocalContent(l) {
        ChainSavedNone(saved, d, b, bd, None, rs, x, LocalContent(x));
      }
      return;
    }
    if |rs| > 0 {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None))); y;
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c) {
        ChainSavedHere(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c);
      } else {
        ChainSavedHere(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None);
      }
    }
  }

  // A document's chain through the pass follows, from now on, the content
  // its file holds now.
  lemma ChainRowsHere(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, base0: Option<Base>, b0: Hash, bd0: bool,
                      read0: Option<(Hash, Kind)>, c0: Option<Hash>, e: DocId, rows: map<DocId, Document>, listing: Listing,
                      rs: seq<Revision>, saved: set<Hash>, x: Option<(Hash, Kind)>)
    requires ChainRows(platform, d, accepted, base0, b0, bd0, read0, c0, e, rows, listing, rs, saved, x)
    ensures ChainRows(platform, d, accepted, base0, b0, bd0, read0, LocalContent(x), e, rows, listing, rs, saved, x)
  {
    ChainSavedHere(saved, d, b0, bd0, read0, rs, x, c0);
  }

  // ---------------------------------------------------------------------
  // G2 of the round: what each conditional effect expects
  // ---------------------------------------------------------------------

  // A conditional overwrite or remove of the apply expects a live revision
  // of the document the server accepted (its clean file holds its live
  // base), or the apply settles another device's revision, which moves its
  // base: a link of its chain.
  lemma ApplyCondClass(platform: Platform, accepted: map<RevId, Revision>, doc: DocId, document: Document, r: Revision,
                       input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, d: DeviceId)
    requires ListingDistinct(platform, input.listing)
    requires document.base.Some? ==>
      document.base.value.rev in accepted && BaseRecords(document.base.value, doc, accepted[document.base.value.rev])
    requires Newer(document, r) ==> PulledBy(document, r, d)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      forall effect | effect in applied.effects && IsCond(effect) && !effect.Move? ::
        AcceptedContent(accepted, doc, CondExpect(effect))
        || (r.device != d && applied.document.base != document.base)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    forall effect | effect in applied.effects && IsCond(effect) && !effect.Move?
      ensures AcceptedContent(accepted, doc, CondExpect(effect))
              || (r.device != d && applied.document.base != document.base)
    {
      if document.base.Some? && !document.base.value.deleted && CondExpect(effect) == document.base.value.content {
        assert accepted[document.base.value.rev].doc == doc;
      }
    }
  }

  // RuleCondClass's case of the rule clearing the way: the head's arrival
  // settles another device's revision.
  lemma ClearWayCondClass(platform: Platform, accepted: map<RevId, Revision>, documents: map<DocId, Document>, doc: DocId,
                          r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires var document := documents[doc];
      var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
      HeldForName(document, applied, r)
    requires documents[doc].base.Some? ==>
      documents[doc].base.value.rev in accepted && BaseRecords(documents[doc].base.value, doc, accepted[documents[doc].base.value.rev])
    requires Newer(documents[doc], r) ==> PulledBy(documents[doc], r, d)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      forall effect | effect in ruled.effects && IsCond(effect) && !effect.Move? ::
        AcceptedContent(accepted, doc, CondExpect(effect))
        || (r.device != d && doc in ruled.documents && ruled.documents[doc].base != documents[doc].base)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    assert !Acknowledges(document, r);
    assert r.device != d;
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      return;
    }
    assert ruled.documents == ClearRows(platform, documents, doc, r, input, aside.value, revs);
    assert doc in ruled.documents && ruled.documents[doc].base == Some(BaseOf(r));
    var front := MoveEffects(platform, documents, doc, aside.value);
    var arrive := ArriveOf(platform, doc, document, r, input);
    MoveEffectsShape(platform, documents, doc, aside.value);
    assert ruled.effects == front + arrive;
    forall effect | effect in ruled.effects && IsCond(effect) && !effect.Move?
      ensures ruled.documents[doc].base != document.base
    {
      assert effect in arrive;
      assert keep.Some?;
      assert !Revives(platform, document, r, input) && document.binding.Some?;
      assert document.base != Some(BaseOf(r));
    }
  }

  // Every conditional overwrite and remove of the rule (RuleSaws: of the
  // settled document's own file) expects a live revision of it the server
  // accepted, or the rule settles another device's revision of it.
  lemma RuleCondClass(platform: Platform, accepted: map<RevId, Revision>, documents: map<DocId, Document>, doc: DocId,
                      r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? ==>
      documents[doc].base.value.rev in accepted && BaseRecords(documents[doc].base.value, doc, accepted[documents[doc].base.value.rev])
    requires Newer(documents[doc], r) ==> PulledBy(documents[doc], r, d)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      forall effect | effect in ruled.effects && IsCond(effect) && !effect.Move? ::
        AcceptedContent(accepted, doc, CondExpect(effect))
        || (r.device != d && doc in ruled.documents && ruled.documents[doc].base != documents[doc].base)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if !HeldForName(document, applied, r) {
      ApplyCondClass(platform, accepted, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc], d);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) { return; }
    ClearWayCondClass(platform, accepted, documents, doc, r, input, revs, first, d);
  }

  // Every write of the apply for its document writes a live revision of it
  // the server accepted, or settles another device's revision with what
  // the row then sees (a merge).
  lemma ApplyWriteClass(platform: Platform, accepted: map<RevId, Revision>, doc: DocId, document: Document, r: Revision,
                        input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, d: DeviceId)
    requires ListingDistinct(platform, input.listing) && AcceptedAs(accepted, r) && r.doc == doc
    requires Newer(document, r) ==> PulledBy(document, r, d)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      forall effect | effect in applied.effects && effect.Write? && effect.target == Some(doc) ::
        AcceptedContent(accepted, doc, effect.content)
        || (r.device != d && applied.document.base != document.base
            && applied.document.binding.Some? && applied.document.binding.value.seen == effect.content)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    forall effect | effect in applied.effects && effect.Write? && effect.target == Some(doc)
      ensures AcceptedContent(accepted, doc, effect.content)
              || (r.device != d && applied.document.base != document.base
                  && applied.document.binding.Some? && applied.document.binding.value.seen == effect.content)
    {
      if !r.deleted && effect.content == r.content {
        assert r.id in accepted && accepted[r.id] == r;
      }
    }
  }

  // ClearWay's writes for the arriving document write the head as it
  // arrives, which its row then sees.
  lemma ClearWayWriteClass(platform: Platform, accepted: map<RevId, Revision>, documents: map<DocId, Document>, doc: DocId,
                           r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && AcceptedAs(accepted, r) && r.doc == doc
    requires var document := documents[doc];
      var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
      HeldForName(document, applied, r)
    requires Newer(documents[doc], r) ==> PulledBy(documents[doc], r, d)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      forall effect | effect in ruled.effects && effect.Write? && effect.target == Some(doc) ::
        AcceptedContent(accepted, doc, effect.content)
        || (r.device != d && doc in ruled.documents && ruled.documents[doc].base != documents[doc].base
            && ruled.documents[doc].binding.Some? && ruled.documents[doc].binding.value.seen == effect.content)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    assert !Acknowledges(document, r);
    assert r.device != d;
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      return;
    }
    assert ruled.documents == ClearRows(platform, documents, doc, r, input, aside.value, revs);
    var head := HeadRow(platform, document, r, input, revs[doc]);
    assert doc in ruled.documents && ruled.documents[doc] == head;
    var front := MoveEffects(platform, documents, doc, aside.value);
    var arrive := ArriveOf(platform, doc, document, r, input);
    MoveEffectsShape(platform, documents, doc, aside.value);
    assert ruled.effects == front + arrive;
    var arriving := Arriving(platform, document, r, input);
    reveal Arriving();
    reveal HeadRow();
    var read := MoveRead(platform, document, r, input);
    forall effect | effect in ruled.effects && effect.Write? && effect.target == Some(doc)
      ensures AcceptedContent(accepted, doc, effect.content)
              || (head.base != document.base && head.binding.value.seen == effect.content)
    {
      assert effect in arrive;
      assert effect.content == arriving.content;
      if effect.content == r.content {
        assert r.id in accepted && accepted[r.id] == r && !r.deleted;
      } else {
        assert read.Some? && MovedContent(document, read.value, r).Some?;
        assert MovedAgainstChange(document, read, r);
        assert head.binding.value.seen == arriving.content;
      }
    }
  }

  // Every write of the rule for the settled document writes a live
  // revision of it the server accepted, or links another device's
  // revision into its chain, with what its row then sees.
  lemma RuleWriteClass(platform: Platform, accepted: map<RevId, Revision>, documents: map<DocId, Document>, doc: DocId,
                       r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && AcceptedAs(accepted, r) && r.doc == doc
    requires Newer(documents[doc], r) ==> PulledBy(documents[doc], r, d)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      forall effect | effect in ruled.effects && effect.Write? && effect.target == Some(doc) ::
        AcceptedContent(accepted, doc, effect.content)
        || (r.device != d && doc in ruled.documents && ruled.documents[doc].base != documents[doc].base
            && ruled.documents[doc].binding.Some? && ruled.documents[doc].binding.value.seen == effect.content)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if !HeldForName(document, applied, r) {
      ApplyWriteClass(platform, accepted, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc], d);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) { return; }
    ClearWayWriteClass(platform, accepted, documents, doc, r, input, revs, first, d);
  }

  // ---------------------------------------------------------------------
  // G2 of the round: the pass keeps what it overwrites
  // ---------------------------------------------------------------------

  // Document `e` was bound before the round to a file the round read.
  ghost predicate ReadBefore(platform: Platform, rows0: map<DocId, Document>, listing0: Listing, e: DocId)
    requires ListingDistinct(platform, listing0)
  {
    e in rows0 && rows0[e].binding.Some? && LocalSide(platform, listing0, rows0[e]).Some?
  }

  // `e`'s chain from its row before the round and what the round read,
  // following content `c`.
  ghost function B0(row0: Document, read0: Option<(Hash, Kind)>): Hash
    requires read0.Some?
  {
    if row0.base.Some? then row0.base.value.content else read0.value.0
  }

  ghost predicate KeptChain(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, row0: Document,
                            read0: Option<(Hash, Kind)>, c: Hash, others: bool, e: DocId, pass: RoundPass)
    requires read0.Some?
  {
    PassChain(platform, d, accepted, row0.base, B0(row0, read0), row0.base.Some? && row0.base.value.deleted, read0, Some(c), others, e, pass)
  }

  // The pass so far: every document read before the round has its chain
  // from what the round read; every conditional effect expecting what the
  // round read in its document's file, and every write for a document read
  // before the round, of content no live accepted revision holds, lies on
  // the document's chain, which settled another device's revision.
  ghost predicate PassKept(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, rows0: map<DocId, Document>,
                           listing0: Listing, pass: RoundPass)
    requires ListingDistinct(platform, listing0)
  {
    (forall e | ReadBefore(platform, rows0, listing0, e) ::
       var read0 := LocalSide(platform, listing0, rows0[e]);
       KeptChain(platform, d, accepted, rows0[e], read0, read0.value.0, false, e, pass))
    && (forall i | 0 <= i < |pass.effects| && IsCond(pass.effects[i]) && !pass.effects[i].Move?
                   && ReadBefore(platform, rows0, listing0, CondDoc(pass.effects[i]))
                   && CondExpect(pass.effects[i]) == LocalSide(platform, listing0, rows0[CondDoc(pass.effects[i])]).value.0
                   && !AcceptedContent(accepted, CondDoc(pass.effects[i]), CondExpect(pass.effects[i])) ::
          var e := CondDoc(pass.effects[i]);
          KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), CondExpect(pass.effects[i]), true, e, pass))
    && (forall i | 0 <= i < |pass.effects| && pass.effects[i].Write? && pass.effects[i].target.Some?
                   && ReadBefore(platform, rows0, listing0, pass.effects[i].target.value)
                   && !AcceptedContent(accepted, pass.effects[i].target.value, pass.effects[i].content) ::
          var e := pass.effects[i].target.value;
          KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), pass.effects[i].content, true, e, pass))
  }

  // A settlement keeps a chain, and links another device's revision into
  // it where it moves the document's base.
  lemma SettleKeepsKeptChain(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                             row0: Document, read0: Option<(Hash, Kind)>, c: Hash, others: bool, e: DocId, pass: RoundPass,
                             doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    requires doc in pass.journal.documents && Newer(pass.journal.documents[doc], r) ==>
               PulledBy(pass.journal.documents[doc], r, d) && NotBuiltOn(pass.journal.documents[doc], r)
               && FirstOwn(pass.journal.documents[doc], r, d)
    requires read0.Some? && KeptChain(platform, d, accepted, row0, read0, c, others, e, pass)
    ensures var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
      KeptChain(platform, d, accepted, row0, read0, c, others || LinksOther(d, pass, doc, r, settled, e), e, settled)
  {
    SettleKeepsChain(platform, device0, d, accepted, row0.base, B0(row0, read0), row0.base.Some? && row0.base.value.deleted, read0, Some(c), others, e, pass,
                     doc, r, input, revs, first);
  }

  // The rule writes only the settled document's files.
  lemma RuleWritesOwn(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                      revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures forall effect | effect in PathRule(platform, documents, doc, r, input, revs, first).effects ::
      effect.Write? && effect.target.Some? ==> effect.target == Some(doc)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if !HeldForName(document, applied, r) { return; }
    if UnsavedCollides(platform, input.unsaved, r.path) { return; }
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      return;
    }
    MoveEffectsShape(platform, documents, doc, aside.value);
    assert ruled.effects == MoveEffects(platform, documents, doc, aside.value) + ArriveOf(platform, doc, document, r, input);
  }

  // A write of the rule for a document read before the round whose
  // content no live accepted revision holds lies on its chain, which
  // settled another device's revision there.
  lemma {:isolate_assertions} SettleWriteKept(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                                              row0: Document, read0: Option<(Hash, Kind)>, pass: RoundPass,
                                              doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, w: Hash)
    requires device0.platform == platform && read0.Some?
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    requires doc in pass.journal.documents && Newer(pass.journal.documents[doc], r) ==>
               PulledBy(pass.journal.documents[doc], r, d) && NotBuiltOn(pass.journal.documents[doc], r)
               && FirstOwn(pass.journal.documents[doc], r, d)
    requires KeptChain(platform, d, accepted, row0, read0, read0.value.0, false, doc, pass)
    requires Distinct(platform, pass.listing) && r.path !in input.outOfScope && doc in pass.journal.documents
    requires var rows := pass.journal.documents;
      var ruled := PathRule(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first);
      r.device != d && doc in ruled.documents && ruled.documents[doc].base != rows[doc].base
      && ruled.documents[doc].binding.Some? && ruled.documents[doc].binding.value.seen == w
    ensures KeptChain(platform, d, accepted, row0, read0, w, true, doc, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(documents, revs, r);
    assert documents[doc := documents[doc]] == documents;
    var ruled := PathRule(platform, documents, doc, r, inner, revs', first);
    assert settled.journal.documents == ruled.documents && settled.listing == ListingAfter(platform, pass.listing, ruled.effects);
    SettleKeepsKeptChain(platform, device0, d, accepted, row0, read0, read0.value.0, false, doc, pass, doc, r, input, revs, first);
    assert LinksOther(d, pass, doc, r, settled, doc);
    if !Distinct(platform, settled.listing) { return; }
    var document := documents[doc];
    assert Newer(document, r) by {
      if !Newer(document, r) {
        var applied := ApplyRevision(platform, doc, document, r, inner, BoundNames(documents), ApplyClaims(documents, first), revs'[doc]);
        assert !HeldForName(document, applied, r);
      }
    }
    assert document.base.Some?;
    assert RowsNameAccepted(accepted, documents);
    assert document.base.value.rev in accepted && BaseRecords(document.base.value, doc, accepted[document.base.value.rev]);
    RuleSynced(platform, documents, doc, r, inner, revs', first, d);
    var b0 := B0(row0, read0);
    var bd0 := row0.base.Some? && row0.base.value.deleted;
    var rs, saved, x :| ChainRows(platform, d, accepted, row0.base, b0, bd0, read0, Some(read0.value.0), doc,
                                  settled.journal.documents, settled.listing, rs, saved, x)
                        && OthersIn(d, rs);
    assert Synced(platform, settled.listing, settled.journal.documents[doc]);
    assert LocalContent(x) == Some(w);
    ChainRowsHere(platform, d, accepted, row0.base, b0, bd0, read0, Some(read0.value.0), doc,
                  settled.journal.documents, settled.listing, rs, saved, x);
  }

  // Each settled revision keeps PassKept.
  lemma {:isolate_assertions} SettleKeepsKept(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                                              rows0: map<DocId, Document>, listing0: Listing, pass: RoundPass,
                                              doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform && ListingDistinct(platform, listing0)
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    requires doc in pass.journal.documents && Newer(pass.journal.documents[doc], r) ==>
               PulledBy(pass.journal.documents[doc], r, d) && NotBuiltOn(pass.journal.documents[doc], r)
               && FirstOwn(pass.journal.documents[doc], r, d)
    requires PassKept(platform, d, accepted, rows0, listing0, pass)
    ensures PassKept(platform, d, accepted, rows0, listing0, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    var documents := pass.journal.documents;
    // The chains so far.
    forall e | ReadBefore(platform, rows0, listing0, e)
      ensures var read0 := LocalSide(platform, listing0, rows0[e]);
        KeptChain(platform, d, accepted, rows0[e], read0, read0.value.0, false, e, settled)
    {
      var read0 := LocalSide(platform, listing0, rows0[e]);
      SettleKeepsKeptChain(platform, device0, d, accepted, rows0[e], read0, read0.value.0, false, e, pass, doc, r, input, revs, first);
      PassChainWeaken(platform, d, accepted, rows0[e].base, B0(rows0[e], read0), rows0[e].base.Some? && rows0[e].base.value.deleted,
                      read0, Some(read0.value.0), LinksOther(d, pass, doc, r, settled, e), false, e, settled);
    }
    // The effects before it, and the ones it adds.
    var added: seq<Effect> := settled.effects[|pass.effects|..];
    assert settled.effects == pass.effects + added by {
      if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
        assert |settled.effects| >= |pass.effects| && settled.effects[..|pass.effects|] == pass.effects;
      } else {
        assert settled.effects == pass.effects;
      }
    }
    if added != [] {
      assert Distinct(platform, pass.listing) && r.path !in input.outOfScope;
    }
    var row := if doc in documents then documents[doc] else NoRow();
    var rows := documents[doc := row];
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    if added != [] {
      var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
      var intents := IntentsFor(doc, r, ruled.effects, pass.n);
      var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
      assert added == guard + ruled.effects;
      RuleSaws(platform, rows, doc, r, inner, revs', first);
      RuleWritesOwn(platform, rows, doc, r, inner, revs', first);
    }
    forall i | 0 <= i < |settled.effects| && IsCond(settled.effects[i]) && !settled.effects[i].Move?
               && ReadBefore(platform, rows0, listing0, CondDoc(settled.effects[i]))
               && CondExpect(settled.effects[i]) == LocalSide(platform, listing0, rows0[CondDoc(settled.effects[i])]).value.0
               && !AcceptedContent(accepted, CondDoc(settled.effects[i]), CondExpect(settled.effects[i]))
      ensures var e := CondDoc(settled.effects[i]);
        KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), CondExpect(settled.effects[i]), true, e, settled)
    {
      var e := CondDoc(settled.effects[i]);
      var read0 := LocalSide(platform, listing0, rows0[e]);
      if i < |pass.effects| {
        assert settled.effects[i] == pass.effects[i];
        SettleKeepsKeptChain(platform, device0, d, accepted, rows0[e], read0, CondExpect(settled.effects[i]), true, e, pass, doc, r, input, revs, first);
      } else {
        CondKept(platform, device0, d, accepted, rows0, listing0, pass, doc, r, input, revs, first, settled.effects[i]);
      }
    }
    forall i | 0 <= i < |settled.effects| && settled.effects[i].Write? && settled.effects[i].target.Some?
               && ReadBefore(platform, rows0, listing0, settled.effects[i].target.value)
               && !AcceptedContent(accepted, settled.effects[i].target.value, settled.effects[i].content)
      ensures var e := settled.effects[i].target.value;
        KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), settled.effects[i].content, true, e, settled)
    {
      var e := settled.effects[i].target.value;
      var read0 := LocalSide(platform, listing0, rows0[e]);
      if i < |pass.effects| {
        assert settled.effects[i] == pass.effects[i];
        SettleKeepsKeptChain(platform, device0, d, accepted, rows0[e], read0, settled.effects[i].content, true, e, pass, doc, r, input, revs, first);
      } else {
        WriteKept(platform, device0, d, accepted, rows0, listing0, pass, doc, r, input, revs, first, settled.effects[i]);
      }
    }
  }

  // SettleKeepsKept's case of a conditional effect the rule adds.
  lemma CondKept(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                 rows0: map<DocId, Document>, listing0: Listing, pass: RoundPass,
                 doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, effect: Effect)
    requires device0.platform == platform && ListingDistinct(platform, listing0)
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    requires doc in pass.journal.documents && Newer(pass.journal.documents[doc], r) ==>
               PulledBy(pass.journal.documents[doc], r, d) && NotBuiltOn(pass.journal.documents[doc], r)
               && FirstOwn(pass.journal.documents[doc], r, d)
    requires PassKept(platform, d, accepted, rows0, listing0, pass)
    requires Distinct(platform, pass.listing) && r.path !in input.outOfScope
    requires var documents := pass.journal.documents;
      var row := if doc in documents then documents[doc] else NoRow();
      var rows := documents[doc := row];
      effect in PathRule(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first).effects
    requires IsCond(effect) && !effect.Move? && ReadBefore(platform, rows0, listing0, CondDoc(effect))
             && CondExpect(effect) == LocalSide(platform, listing0, rows0[CondDoc(effect)]).value.0
             && !AcceptedContent(accepted, CondDoc(effect), CondExpect(effect))
    ensures var e := CondDoc(effect);
      KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), CondExpect(effect), true, e,
                SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var rows := documents[doc := row];
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    RuleSaws(platform, rows, doc, r, inner, revs', first);
    var e := CondDoc(effect);
    assert e == doc;
    var read0 := LocalSide(platform, listing0, rows0[e]);
    // The document's chain is in the pass's rows.
    assert KeptChain(platform, d, accepted, rows0[e], read0, read0.value.0, false, e, pass);
    assert doc in documents;
    assert rows == documents;
    RuleCondClass(platform, accepted, rows, doc, r, inner, revs', first, d);
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    assert LinksOther(d, pass, doc, r, settled, e);
    SettleKeepsKeptChain(platform, device0, d, accepted, rows0[e], read0, read0.value.0, false, e, pass, doc, r, input, revs, first);
  }

  // SettleKeepsKept's case of a write the rule adds.
  lemma WriteKept(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                  rows0: map<DocId, Document>, listing0: Listing, pass: RoundPass,
                  doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, effect: Effect)
    requires device0.platform == platform && ListingDistinct(platform, listing0)
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    requires doc in pass.journal.documents && Newer(pass.journal.documents[doc], r) ==>
               PulledBy(pass.journal.documents[doc], r, d) && NotBuiltOn(pass.journal.documents[doc], r)
               && FirstOwn(pass.journal.documents[doc], r, d)
    requires PassKept(platform, d, accepted, rows0, listing0, pass)
    requires Distinct(platform, pass.listing) && r.path !in input.outOfScope
    requires var documents := pass.journal.documents;
      var row := if doc in documents then documents[doc] else NoRow();
      var rows := documents[doc := row];
      effect in PathRule(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first).effects
    requires effect.Write? && effect.target.Some? && ReadBefore(platform, rows0, listing0, effect.target.value)
             && !AcceptedContent(accepted, effect.target.value, effect.content)
    ensures var e := effect.target.value;
      KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), effect.content, true, e,
                SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var rows := documents[doc := row];
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    RuleWritesOwn(platform, rows, doc, r, inner, revs', first);
    var e := effect.target.value;
    assert e == doc;
    var read0 := LocalSide(platform, listing0, rows0[e]);
    assert KeptChain(platform, d, accepted, rows0[e], read0, read0.value.0, false, e, pass);
    assert doc in documents;
    assert rows == documents;
    RuleWriteClass(platform, accepted, rows, doc, r, inner, revs', first, d);
    SettleWriteKept(platform, device0, d, accepted, rows0[e], read0, pass, doc, r, input, revs, first, effect.content);
  }

  lemma SettlePulledKeepsKept(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                              rows0: map<DocId, Document>, listing0: Listing, pass: RoundPass,
                              revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform && ListingDistinct(platform, listing0)
    requires PassNUD(platform, device0, accepted, pass)
    requires PassKept(platform, d, accepted, rows0, listing0, pass)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    requires PulledInPass(platform, d, pass, revisions, input, revs, first)
    ensures PassKept(platform, d, accepted, rows0, listing0, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      var next := SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsKept(platform, device0, d, accepted, rows0, listing0, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsNUD(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsKept(platform, device0, d, accepted, rows0, listing0, next, revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsKept(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                       rows0: map<DocId, Document>, listing0: Listing, pass: RoundPass,
                       docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform && ListingDistinct(platform, listing0)
    requires PassNUD(platform, device0, accepted, pass)
    requires PassKept(platform, d, accepted, rows0, listing0, pass)
    requires RetriedInPass(platform, d, pass, docs, input, revs, first)
    ensures PassKept(platform, d, accepted, rows0, listing0, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        assert PassNUD(platform, device0, accepted, cleared);
        ClearedKeepsKept(platform, d, accepted, rows0, listing0, pass, cleared, docs[0]);
        var r := row.ahead.value.revision;
        assert AcceptedAs(accepted, r) && r.doc == docs[0];
        SettleKeepsKept(platform, device0, d, accepted, rows0, listing0, cleared, docs[0], r, input, revs, first);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        RetryKeepsKept(platform, device0, d, accepted, rows0, listing0, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsKept(platform, device0, d, accepted, rows0, listing0, pass, docs[1..], input, revs, first);
      }
    }
  }

  // Clearing a row's ahead keeps every chain (RetryKeepsChain's step).
  lemma ClearedKeepsKept(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>,
                         rows0: map<DocId, Document>, listing0: Listing, pass: RoundPass, cleared: RoundPass, f: DocId)
    requires ListingDistinct(platform, listing0)
    requires f in pass.journal.documents && pass.journal.documents[f].ahead.Some?
    requires cleared == pass.(journal := pass.journal.(documents := pass.journal.documents[f := pass.journal.documents[f].(ahead := None)]))
    requires PassKept(platform, d, accepted, rows0, listing0, pass)
    ensures PassKept(platform, d, accepted, rows0, listing0, cleared)
  {
    forall e: DocId, read0: Option<(Hash, Kind)>, c: Hash, others: bool
      | e in rows0 && read0.Some? && KeptChain(platform, d, accepted, rows0[e], read0, c, others, e, pass)
      ensures KeptChain(platform, d, accepted, rows0[e], read0, c, others, e, cleared)
    {
      ClearedKeepsChain(platform, d, accepted, rows0[e].base, B0(rows0[e], read0), rows0[e].base.Some? && rows0[e].base.value.deleted,
                        read0, Some(c), others, e, pass, cleared, f);
    }
  }

  lemma ClearedKeepsChain(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, base0: Option<Base>, b0: Hash, bd0: bool,
                          read0: Option<(Hash, Kind)>, c0: Option<Hash>, others: bool, e: DocId, pass: RoundPass, cleared: RoundPass, f: DocId)
    requires f in pass.journal.documents && pass.journal.documents[f].ahead.Some?
    requires cleared == pass.(journal := pass.journal.(documents := pass.journal.documents[f := pass.journal.documents[f].(ahead := None)]))
    requires PassChain(platform, d, accepted, base0, b0, bd0, read0, c0, others, e, pass)
    ensures PassChain(platform, d, accepted, base0, b0, bd0, read0, c0, others, e, cleared)
  {
    var documents := pass.journal.documents;
    if Distinct(platform, pass.listing) {
      var rs, saved, x :| ChainRows(platform, d, accepted, base0, b0, bd0, read0, c0, e, documents, pass.listing, rs, saved, x)
                          && (others ==> OthersIn(d, rs));
      var rows' := cleared.journal.documents;
      assert forall g | g in rows' :: g in documents && rows'[g].binding == documents[g].binding && rows'[g].base == documents[g].base;
      assert SavedHeld(platform, accepted, rows', cleared.listing, saved) by {
        forall h | h in saved && UntrackedHolds(platform, documents, pass.listing, h)
          ensures UntrackedHolds(platform, rows', cleared.listing, h)
        {
          var p := var p :| p in pass.listing && pass.listing[p].0 == h
            && forall g | g in documents && documents[g].binding.Some? :: !SameF(platform, documents[g].binding.value.spelling, p); p;
        }
      }
      assert ChainRows(platform, d, accepted, base0, b0, bd0, read0, c0, e, rows', cleared.listing, rs, saved, x);
    }
  }

  // At the start of the round: no effects, and every chain empty.
  lemma PassKeptStart(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, start: RoundPass)
    requires forall i | 0 <= i < |start.effects| :: !start.effects[i].Write? && !start.effects[i].Remove?
    requires forall e | e in start.journal.documents :: AheadAboveBase(start.journal.documents[e])
    requires ListingDistinct(platform, start.listing) && Distinct(platform, start.listing)
    ensures PassKept(platform, d, accepted, start.journal.documents, start.listing, start)
  {
    var rows0 := start.journal.documents;
    forall e | ReadBefore(platform, rows0, start.listing, e)
      ensures var read0 := LocalSide(platform, start.listing, rows0[e]);
        KeptChain(platform, d, accepted, rows0[e], read0, read0.value.0, false, e, start)
    {
      var read0 := LocalSide(platform, start.listing, rows0[e]);
      PassChainStart(platform, d, accepted, e, start, B0(rows0[e], read0), rows0[e].base.Some? && rows0[e].base.value.deleted);
    }
  }

  // ---------------------------------------------------------------------
  // G2 of the round: RoundKept
  // ---------------------------------------------------------------------

  // Document `e` was bound before the step to a file the round read.
  ghost predicate RoundReadOf(step: Step, e: DocId)
    requires RoundEvent(step.event) && step.event.device in step.pre.devices
  {
    var device := step.pre.devices[step.event.device];
    e in device.journal.documents && device.journal.documents[e].binding.Some?
    && RoundRead(step, device.journal.documents[e].binding.value.spelling).Some?
  }

  // Every write of the round for a document with no file the round read
  // before it writes a live version of it the server accepted. A proof
  // obligation of the round: its merges are of a file it read.
  ghost predicate UnreadWritesAccepted(step: Step)
    requires RoundEvent(step.event) && step.event.device in step.pre.devices
  {
    forall j | 0 <= j < |step.effects| && step.effects[j].Write? && step.effects[j].target.Some?
                 && !RoundReadOf(step, step.effects[j].target.value) ::
      DocVersion(step, step.effects[j].target.value, step.effects[j].content)
  }

  // RoundKept from the round's chains: every content a conditional effect
  // expects in the file the round read, and every write, holds a live
  // accepted version, or lies on the document's chain (RoundChain).
  lemma RoundKeptFrom(step: Step)
    requires step.event.SyncRound? && step.event.device in step.pre.devices
    requires UnreadWritesAccepted(step)
    requires forall i | 0 <= i < |step.effects| && IsCond(step.effects[i]) && !step.effects[i].Move?
                        && RoundReadOf(step, CondDoc(step.effects[i]))
                        && RoundRead(step, step.pre.devices[step.event.device].journal.documents[CondDoc(step.effects[i])].binding.value.spelling).value.0
                           == CondExpect(step.effects[i])
                        && !DocVersion(step, CondDoc(step.effects[i]), CondExpect(step.effects[i])) ::
               exists rs :: RoundChain(step, step.event.device, CondDoc(step.effects[i]), rs, CondExpect(step.effects[i]))
    requires forall j | 0 <= j < |step.effects| && step.effects[j].Write? && step.effects[j].target.Some?
                        && RoundReadOf(step, step.effects[j].target.value)
                        && !DocVersion(step, step.effects[j].target.value, step.effects[j].content) ::
               exists rs :: RoundChain(step, step.event.device, step.effects[j].target.value, rs, step.effects[j].content)
    ensures RoundKept(step)
  {
    forall i | 0 <= i < |step.effects| && IsCond(step.effects[i]) && !step.effects[i].Move?
      ensures KeptBase(step, CondDoc(step.effects[i]), CondExpect(step.effects[i]))
              && KeptWrites(step, i, CondDoc(step.effects[i]), CondExpect(step.effects[i]))
    {
      var e := CondDoc(step.effects[i]);
      var c := CondExpect(step.effects[i]);
      if RoundReadOf(step, e)
         && RoundRead(step, step.pre.devices[step.event.device].journal.documents[e].binding.value.spelling).value.0 == c
         && !DocVersion(step, e, c) {
        var rs :| RoundChain(step, step.event.device, e, rs, c);
        assert ReadKept(step, e, c);
      }
      forall j | 0 <= j < i && step.effects[j].Write? && step.effects[j].target == Some(e) && step.effects[j].content == c
        ensures ReadKept(step, e, c) || DocVersion(step, e, c)
      {
        if !DocVersion(step, e, c) {
          var rs :| RoundChain(step, step.event.device, e, rs, c);
          assert ReadKept(step, e, c);
        }
      }
    }
  }

  // RoundKept of the round: what each conditional overwrite and remove
  // expects in the file the round read, and each write, is a live accepted
  // version or lies on the document's chain.
  lemma {:isolate_assertions} RoundKeptHolds(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires G5_NeverJoined(pre) && JournalsNameAccepted(pre) && G7_OneFilePerName(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    // Proof obligations of the state before the round, which its caller discharges.
    requires RoundPulledBy(pre, d, input, revs)
    requires forall e | e in pre.devices[d].journal.documents :: AheadAboveBase(pre.devices[d].journal.documents[e])
    // A proof obligation of the round.
    requires UnreadWritesAccepted(RoundStepOf(pre, d, input, revs))
    ensures RoundKept(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var accepted := pre.server.accepted;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    RoundStepJournal(pre, d, input, revs);
    if !(forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs) {
      assert step.post.devices[d] == device;
      assert step.effects == [];
      return;
    }
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    assert step.effects == settled.effects + push.1;
    assert OneFilePerName(platform, device.disk);
    assert input.listing == ListingOf(device);
    OneFileDistinct(platform, device.disk);
    assert NeverJoinedRows(platform, journal.documents);
    assert RowsNameAccepted(accepted, journal.documents);
    forall e | e in start.journal.documents
      ensures RowOrigin(platform, device, accepted, start.effects, start.listing, e, start.journal.documents[e])
    {
      if journal.documents[e].binding.Some? {
        assert SameF(platform, journal.documents[e].binding.value.spelling, journal.documents[e].binding.value.spelling);
        assert BoundTo(device, e, journal.documents[e].binding.value.spelling);
      }
    }
    assert PassNUD(platform, device, accepted, start);
    var rows0 := journal.documents;
    var listing0 := input.listing;
    assert start.journal.documents == rows0 && start.listing == listing0;
    assert forall i | 0 <= i < |start.effects| :: start.effects[i] == Pull(journal.cursor);
    assert forall e | e in rows0 :: AheadAboveBase(rows0[e]);
    PassKeptStart(platform, d, accepted, start);
    RetryKeepsKept(platform, device, d, accepted, rows0, listing0, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsNUD(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    if behind {
      var ids := feed[journal.cursor..];
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |pulled| ensures AcceptedAs(accepted, pulled[i]) {
        assert pulled[i] in pulled;
      }
    }
    SettlePulledKeepsKept(platform, device, d, accepted, rows0, listing0, retried, pulled, input, revs, first);
    PushTouchesNoFile(platform, read, input', revs);
    // The pass's chains end in the round's.
    forall e: DocId, c: Hash | ReadBefore(platform, rows0, listing0, e)
        && KeptChain(platform, d, accepted, rows0[e], LocalSide(platform, listing0, rows0[e]), c, true, e, settled)
      ensures RoundReadOf(step, e) && exists rs :: RoundChain(step, d, e, rs, c)
    {
      assert settled == RoundSettledPass(pre, d, input, revs) by { reveal RoundSettledPass(); }
      KeptChainEnds(pre, d, input, revs, e, c);
    }
    // What the round read in a document's file is its local side.
    forall e | RoundReadOf(step, e)
      ensures ReadBefore(platform, rows0, listing0, e)
              && RoundRead(step, rows0[e].binding.value.spelling) == LocalSide(platform, listing0, rows0[e])
    {
      ReadAtListed(device, rows0[e].binding.value.spelling);
    }
    forall c, e | AcceptedContent(accepted, e, c) ensures DocVersion(step, e, c) {
      var rev :| rev in accepted && accepted[rev].doc == e && !accepted[rev].deleted && accepted[rev].content == c;
    }
    // Push effects are neither conditional nor writes.
    forall k | |settled.effects| <= k < |step.effects|
      ensures !step.effects[k].Write? && !step.effects[k].Remove? && !step.effects[k].Move?
    {
      assert step.effects[k] in push.1;
    }
    RoundKeptFrom(step);
  }

  // The pass of the round, before its push.
  opaque ghost function RoundSettledPass(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): RoundPass
    requires d in pre.devices
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var feed := pre.server.feed;
    var pulled := if journal.cursor < |feed| then Revisions(pre.server, feed[journal.cursor..]) else [];
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulled(platform, retried, pulled, input, revs, first)
  }

  // A chain of the pass that settled another device's revision ends as
  // the round's chain (RoundG6Chain's end).
  lemma {:isolate_assertions} KeptChainEnds(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs, e: DocId, c: Hash)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires G5_NeverJoined(pre) && JournalsNameAccepted(pre) && G7_OneFilePerName(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    requires ListingDistinct(pre.devices[d].platform, input.listing)
    requires ReadBefore(pre.devices[d].platform, pre.devices[d].journal.documents, input.listing, e)
    requires var rows0 := pre.devices[d].journal.documents;
      KeptChain(pre.devices[d].platform, d, pre.server.accepted, rows0[e], LocalSide(pre.devices[d].platform, input.listing, rows0[e]), c, true, e,
                RoundSettledPass(pre, d, input, revs))
    ensures RoundReadOf(RoundStepOf(pre, d, input, revs), e)
    ensures exists rs :: RoundChain(RoundStepOf(pre, d, input, revs), d, e, rs, c)
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var accepted := pre.server.accepted;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    RoundStepJournal(pre, d, input, revs);
    var row0 := journal.documents[e];
    var after := step.post.devices[d];
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    assert settled == RoundSettledPass(pre, d, input, revs) by { reveal RoundSettledPass(); }
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    assert step.effects == settled.effects + push.1;
    assert after.journal == push.0;
    assert OneFilePerName(platform, device.disk);
    assert input.listing == ListingOf(device);
    OneFileDistinct(platform, device.disk);
    assert NeverJoinedRows(platform, journal.documents);
    assert RowsNameAccepted(accepted, journal.documents);
    forall f | f in start.journal.documents
      ensures RowOrigin(platform, device, accepted, start.effects, start.listing, f, start.journal.documents[f])
    {
      if journal.documents[f].binding.Some? {
        assert SameF(platform, journal.documents[f].binding.value.spelling, journal.documents[f].binding.value.spelling);
        assert BoundTo(device, f, journal.documents[f].binding.value.spelling);
      }
    }
    assert PassNUD(platform, device, accepted, start);
    PassG5Start(device, start, journal.cursor);
    RetryKeepsG5(platform, device, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsNUD(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    if behind {
      var ids := feed[journal.cursor..];
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |pulled| ensures AcceptedAs(accepted, pulled[i]) {
        assert pulled[i] in pulled;
      }
    }
    SettlePulledKeepsG5(platform, device, retried, pulled, input, revs, first);
    var read0 := LocalSide(platform, input.listing, row0);
    ReadAtListed(device, row0.binding.value.spelling);
    assert RoundRead(step, row0.binding.value.spelling) == read0;
    PushTouchesNoFile(platform, read, input', revs);
    RoundDisksFollowEffects(pre, d, input, revs);
    assert EffectsTake(platform, device.disk, step.effects, after.disk);
    EffectsTakeSplit(platform, device.disk, settled.effects, push.1, after.disk);
    var mid := var mid :| EffectsTake(platform, device.disk, settled.effects, mid) && EffectsTake(platform, mid, push.1, after.disk); mid;
    PushKeepsDisk(platform, mid, push.1, after.disk);
    assert DiskMap(after.disk) == settled.listing && OneFilePerName(platform, after.disk);
    assert DiskMap(after.disk) == ListingOf(after);
    OneFileDistinct(platform, after.disk);
    assert Distinct(platform, settled.listing);
    var rows := settled.journal.documents;
    var b0 := B0(row0, read0);
    var bd0 := row0.base.Some? && row0.base.value.deleted;
    var rs: seq<Revision>, saved: set<Hash>, x: Option<(Hash, Kind)> :|
      ChainRows(platform, d, accepted, row0.base, b0, bd0, read0, Some(c), e, rows, settled.listing, rs, saved, x) && OthersIn(d, rs);
    var created := Created(platform, read, input', revs);
    assert created[e] == rows[e];
    assert after.journal.documents[e] == Seal(rows[e]);
    assert after.journal.documents[e].base == rows[e].base;
    assert |rs| > 0;
    var last := rs[|rs| - 1];
    assert AcceptedAs(accepted, last);
    forall h | h in saved ensures SavedInRound(step.post, d, h) {
      if !AcceptedLive(accepted, h) {
        PushKeepsUntracked(platform, read, input', revs, settled.listing, after, h);
      }
    }
    ChainSavedIsThrough(step.post, saved, d, b0, bd0, read0, rs, x, Some(c));
    PushSends(platform, read, input', revs, settled.listing, after, e);
    assert ChainEnds(step.post, d, e, LocalContent(x));
    forall k | 0 <= k < |rs| ensures rs[k].id in step.post.server.accepted && step.post.server.accepted[rs[k].id] == rs[k] && rs[k].doc == e {
      assert AcceptedAs(accepted, rs[k]);
    }
    assert ChainThrough(step.post, d, b0, bd0, read0, rs, LocalContent(x), Some(c));
    assert row0.base.Some? || rs[0].device == d;
    assert RoundChain(step, d, e, rs, c);
  }

  // G2_OnlyWhatItSaw of the round.
  lemma RoundG2OnlyWhatItSaw(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires G5_NeverJoined(pre) && JournalsNameAccepted(pre) && G7_OneFilePerName(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    // Proof obligations of the state before the round, which its caller discharges.
    requires RoundPulledBy(pre, d, input, revs)
    requires forall e | e in pre.devices[d].journal.documents :: AheadAboveBase(pre.devices[d].journal.documents[e])
    // A proof obligation of the round.
    requires UnreadWritesAccepted(RoundStepOf(pre, d, input, revs))
    ensures G2_OnlyWhatItSaw(RoundStepOf(pre, d, input, revs))
  {
    RoundKeptHolds(pre, d, input, revs);
    RoundG2OnlyWhatItSawKept(pre, d, input, revs);
  }

  // ---------------------------------------------------------------------
  // G1 of the round: from what it drops
  // ---------------------------------------------------------------------

  // The server holds content `c` as a live head or a live revision in its
  // history: a version with those bytes is retrievable whatever any disk
  // holds.
  ghost predicate ServerHoldsContent(server: Server, c: Hash) {
    (exists doc :: Head(server, doc).Some? && !Head(server, doc).value.deleted && Head(server, doc).value.content == c)
    || (exists other :: InHistory(server, other) && !server.revisions[other].deleted && server.revisions[other].content == c)
  }

  // Every accepted revision is in the server's history, or retention purged
  // it, or a restore from backup removed it (`lost`).
  ghost predicate AcceptedAccounted(server: Server) {
    forall rev | rev in server.accepted :: InHistory(server, rev) || rev in server.purged || rev in server.lost
  }

  // Every content the round's device held before the round and holds
  // nowhere after it is one the server holds, or one the round keeps
  // (ReadKept: sent, saved next to it, merged, or on a document's chain).
  ghost predicate RoundDropsOnlyKept(step: Step)
    requires RoundEvent(step.event)
  {
    var d := step.event.device;
    d in step.pre.devices && d in step.post.devices
    && forall c :: OnDisk(step.pre.devices[d], c) && !OnDisk(step.post.devices[d], c) ==>
         ServerHoldsContent(step.pre.server, c) || exists doc :: ReadKept(step, doc, c)
  }

  // G1_OnlyRetentionRemoves of the round, where every accepted revision is
  // accounted for and the round drops only contents it keeps or the server
  // holds. The round changes neither the server nor another device, so a
  // version stops being retrievable only where the round's device held its
  // bytes and no longer does: retention purged it, or a restore lost it and
  // the round keeps its bytes.
  lemma RoundG1FromDrops(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    requires AcceptedAccounted(pre.server)
    requires RoundDropsOnlyKept(RoundStepOf(pre, d, input, revs))
    ensures G1_OnlyRetentionRemoves(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    RoundOnlyTouchesDevice(pre, d, input, revs);
    var server := pre.server;
    assert step.post.server == server;
    forall rev | rev in step.pre.server.accepted && rev in step.post.server.accepted
                 && Retrievable(step.pre, rev) && !Retrievable(step.post, rev)
      ensures rev in server.purged
              || (rev in server.lost && RoundEvent(step.event)
                  && exists doc :: ReadKept(step, doc, server.accepted[rev].content))
    {
      var version := server.accepted[rev];
      var c := version.content;
      assert !InHistory(server, rev);
      assert !version.deleted;
      assert !ServerHoldsContent(server, c);
      var x :| x in pre.devices && OnDisk(pre.devices[x], c);
      if x != d {
        assert step.post.devices[x] == pre.devices[x];
        assert OnDisk(step.post.devices[x], c);
        assert false;
      }
      assert !OnDisk(step.post.devices[d], c);
    }
  }
}
