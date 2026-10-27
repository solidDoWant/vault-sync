// Types of the Dafny-compiled plugin/src/verified/gen/verified.cjs. NOT
// generated: Dafny emits no declarations, so this file is written by hand and
// scripts/verified-js.sh never touches it (TypeScript only finds it next to the
// .cjs). Only what the wrappers in plugin/src/verified/ use is declared;
// Dafny's `int` is a BigNumber.
import type BigNumber from "bignumber.js";

// Dafny values as the compiled code represents them. A `string` is a
// sequence of code points; a map is an array of [key, value] pairs.
declare namespace Dafny {
  interface Str extends ReadonlyArray<unknown> {
    toVerbatimString(asLiteral: boolean): string;
  }
  interface Map<K, V> extends ReadonlyArray<readonly [K, V]> {
    update(key: K, value: V): Map<K, V>;
    get(key: K): V | undefined;
  }
  interface Set<T> extends ReadonlyArray<T> {
    contains(value: T): boolean;
  }
  type Seq<T> = ReadonlyArray<T>;
  type Tuple2<A, B> = readonly [A, B];

  interface Option<T> {
    readonly is_Some: boolean;
    readonly dtor_value: T;
  }
  interface Kind {
    readonly is_Note: boolean;
  }
  interface Absence {
    readonly is_UserDeleted: boolean;
    readonly is_Released: boolean;
    readonly is_Never: boolean;
  }
  interface Base {
    readonly dtor_rev: Str;
    readonly dtor_position: BigNumber;
    readonly dtor_path: Str;
    readonly dtor_content: Str;
    readonly dtor_kind: Kind;
    readonly dtor_deleted: boolean;
  }
  interface Binding {
    readonly dtor_spelling: Str;
    readonly dtor_seen: Str;
    readonly dtor_displaced: boolean;
    readonly dtor_userSpelling: Option<Str>;
  }
  interface Outbox {
    readonly dtor_rev: Str;
    readonly dtor_baseRev: Option<Str>;
    readonly dtor_path: Str;
    readonly dtor_content: Str;
    readonly dtor_kind: Kind;
    readonly dtor_deleted: boolean;
    readonly dtor_sealed: boolean;
    readonly dtor_rejected: boolean;
  }
  interface Document {
    readonly dtor_base: Option<Base>;
    readonly dtor_ahead: Option<unknown>;
    readonly dtor_binding: Option<Binding>;
    readonly dtor_absence: Absence;
    readonly dtor_outbox: Option<Outbox>;
  }
  interface Journal {
    readonly dtor_documents: Map<Str, Document>;
    readonly dtor_cursor: BigNumber;
    readonly dtor_intents: Seq<unknown>;
    readonly dtor_conflicts: Seq<unknown>;
  }
  interface LocalEvent {
    readonly $tag: number;
  }
  interface Effect {
    readonly is_PersistJournal: boolean;
    readonly dtor_journal: Journal;
    toString(): string;
  }
  type Read = Option<Tuple2<Str, Kind>>;
  interface DatatypeOf<T> {
    create_None(): Option<T>;
    create_Some(value: T): Option<T>;
  }
}

declare const verified: {
  Clamp: {
    __default: {
      Clamp(x: BigNumber, lo: BigNumber, hi: BigNumber): BigNumber;
    };
  };
  // The verified local-event core (plugin/verified/LocalCoreJs.dfy).
  LocalCoreJs: {
    __default: {
      OnLocal(
        platform: Dafny.Str,
        journal: Dafny.Journal,
        local: Dafny.LocalEvent,
        input: Dafny.Map<Dafny.Str, Dafny.Read>,
        revs: Dafny.Map<Dafny.Str, Dafny.Str>,
      ): Dafny.Tuple2<Dafny.Journal, Dafny.Seq<Dafny.Effect>>;
      OnScan(
        platform: Dafny.Str,
        journal: Dafny.Journal,
        listing: Dafny.Map<Dafny.Str, Dafny.Tuple2<Dafny.Str, Dafny.Kind>>,
        revs: Dafny.Map<Dafny.Str, Dafny.Str>,
      ): Dafny.Tuple2<Dafny.Journal, Dafny.Seq<Dafny.Effect>>;
    };
    Option: Dafny.DatatypeOf<unknown>;
    Kind: { create_Note(): Dafny.Kind; create_Binary(): Dafny.Kind };
    Absence: {
      create_UserDeleted(): Dafny.Absence;
      create_Released(): Dafny.Absence;
      create_Never(): Dafny.Absence;
    };
    Base: {
      create_Base(
        rev: Dafny.Str,
        position: BigNumber,
        path: Dafny.Str,
        content: Dafny.Str,
        kind: Dafny.Kind,
        deleted: boolean,
      ): Dafny.Base;
    };
    Binding: {
      create_Binding(
        spelling: Dafny.Str,
        seen: Dafny.Str,
        displaced: boolean,
        userSpelling: Dafny.Option<Dafny.Str>,
      ): Dafny.Binding;
    };
    Outbox: {
      create_Outbox(
        rev: Dafny.Str,
        baseRev: Dafny.Option<Dafny.Str>,
        path: Dafny.Str,
        content: Dafny.Str,
        kind: Dafny.Kind,
        deleted: boolean,
        sealed: boolean,
        rejected: boolean,
      ): Dafny.Outbox;
    };
    Document: {
      create_Document(
        base: Dafny.Option<Dafny.Base>,
        ahead: Dafny.Option<unknown>,
        binding: Dafny.Option<Dafny.Binding>,
        absence: Dafny.Absence,
        outbox: Dafny.Option<Dafny.Outbox>,
      ): Dafny.Document;
    };
    Journal: {
      create_Journal(
        documents: Dafny.Map<Dafny.Str, Dafny.Document>,
        cursor: BigNumber,
        intents: Dafny.Seq<unknown>,
        conflicts: Dafny.Seq<unknown>,
      ): Dafny.Journal;
    };
    LocalEvent: {
      create_Created(path: Dafny.Str): Dafny.LocalEvent;
      create_Modified(path: Dafny.Str): Dafny.LocalEvent;
      create_Deleted(path: Dafny.Str): Dafny.LocalEvent;
      create_Renamed(from: Dafny.Str, to: Dafny.Str): Dafny.LocalEvent;
    };
  };
  // The extern module the compiled core calls for path keys; its functions
  // are installed by plugin/src/verified/local-core.ts.
  VerifiedPathHost: Record<string, unknown>;
  _dafny: {
    Seq: {
      UnicodeFromString(value: string): Dafny.Str;
      of<T>(...elements: T[]): Dafny.Seq<T>;
    };
    Map: { readonly Empty: Dafny.Map<never, never> };
    Set: { fromElements<T>(...elements: T[]): Dafny.Set<T> };
    Tuple: { of<A, B>(first: A, second: B): Dafny.Tuple2<A, B> };
  };
};

export = verified;
