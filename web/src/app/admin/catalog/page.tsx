"use client";

import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "@/lib/api";
import { Title, TitleSource } from "@/lib/types";
import MetadataPicker from "@/components/MetadataPicker";
import type { MetadataDetails } from "@/lib/metadata";
import Link from "next/link";

interface EditorState {
  id?: string;
  name: string;
  description: string;
  type: "movie" | "series";
  genres: string;
  year: string;
  posterUrl: string;
  backdropUrl: string;
  sources: TitleSource[];
}

const EMPTY: EditorState = {
  name: "",
  description: "",
  type: "movie",
  genres: "",
  year: "",
  posterUrl: "",
  backdropUrl: "",
  sources: [],
};

export default function AdminCatalogPage() {
  const [titles, setTitles] = useState<Title[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metadataFor, setMetadataFor] = useState<Title | "draft" | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [draftMetadata, setDraftMetadata] = useState<MetadataDetails | null>(null);

  const load = useCallback(() => {
    get<{ titles: Title[] }>("/api/admin/catalog")
      .then((r) => setTitles(r.titles))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const openEditor = (title?: Title) => {
    setMetadataFor(null); setNotice(""); setDraftMetadata(null);
    setEditor(
      title
        ? {
            id: title.id,
            name: title.name,
            description: title.description,
            type: title.type,
            genres: title.genres.join(", "),
            year: title.year?.toString() ?? "",
            posterUrl: title.posterUrl ?? "",
            backdropUrl: title.backdropUrl ?? "",
            sources: title.sources ?? [],
          }
        : { ...EMPTY, sources: [] }
    );
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editor || saving) return;
    setSaving(true); setError(null);
    const payload = {
      name: editor.name,
      description: editor.description,
      type: editor.type,
      genres: editor.genres.split(",").map((g) => g.trim()).filter(Boolean),
      year: editor.year ? parseInt(editor.year, 10) : null,
      posterUrl: editor.posterUrl || null,
      backdropUrl: editor.backdropUrl || null,
      sources: editor.sources.filter((s) => s.url.trim() !== ""),
      ...(!editor.id && draftMetadata ? { metadataMatch: { provider: draftMetadata.provider, id: draftMetadata.id, type: draftMetadata.type } } : {}),
    };
    try {
      if (editor.id) {
        await patch(`/api/admin/catalog/${editor.id}/update`, payload);
        setNotice("Title saved. Your playback sources are preserved.");
      } else {
        const response = await post<{ title: Title; metadataQueued?: boolean }>("/api/admin/catalog/create", payload);
        setNotice(response.metadataQueued ? "Title saved. Metadata enrichment is queued; cast, ratings, and IMDb details will arrive in the background." : "Title saved.");
      }
      setEditor(null); setMetadataFor(null); setDraftMetadata(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally { setSaving(false); }
  };

  const remove = async (title: Title) => {
    if (!confirm(`Delete "${title.name}"?`)) return;
    try {
      await del(`/api/admin/catalog/${title.id}/delete`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const setSource = (i: number, patchSrc: Partial<TitleSource>) => {
    setEditor((ed) =>
      ed
        ? { ...ed, sources: ed.sources.map((s, idx) => (idx === i ? { ...s, ...patchSrc } : s)) }
        : ed
    );
  };

  function fillMetadata(metadata: MetadataDetails) {
    setDraftMetadata(metadata);
    setEditor(current => current ? {
      ...current, name: metadata.name, year: metadata.year?.toString() ?? "", type: metadata.type,
      description: metadata.description, genres: metadata.genres.join(", "),
      posterUrl: metadata.posterUrl ?? "", backdropUrl: metadata.backdropUrl ?? "",
    } : current);
    setMetadataFor(null); setNotice("Metadata copied into your draft. Review the fields and save to keep them. Your playback sources are preserved.");
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <span className="dim">{titles.length} titles</span>
        <button className="btn" onClick={() => openEditor()}>+ Add title</button>
      </div>
      <p className="dim" style={{ fontSize: 12, lineHeight: 1.8, marginBottom: 20 }}>Connect artwork and movie/TV details from <Link href="/admin/metadata" style={{ textDecoration: "underline" }}>metadata providers</Link>. Automatic matching is opt-in, and you can fix a match or protect fields there.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {notice && <p className="ok-text" role="status">{notice}</p>}
      {metadataFor && <div style={{ marginBottom: 24 }}><MetadataPicker
        key={metadataFor === "draft" ? `draft-${editor?.id ?? "new"}` : metadataFor.id}
        query={metadataFor === "draft" ? editor?.name ?? "" : metadataFor.name}
        type={metadataFor === "draft" ? editor?.type ?? "movie" : metadataFor.type}
        year={(metadataFor === "draft" ? Number(editor?.year) || undefined : metadataFor.year) ?? undefined}
        target={metadataFor === "draft" ? undefined : { type: "catalog", id: metadataFor.id }}
        onSelect={fillMetadata} onClose={() => setMetadataFor(null)} onApplied={() => { setMetadataFor(null); setEditor(null); load(); setNotice("Metadata match applied. Protected fields and playback sources are preserved."); }}
      /></div>}

      {editor && (
        <form className="card" style={{ marginBottom: 24 }} onSubmit={save}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}><h2 style={{ fontSize: 17 }}>{editor.id ? "Edit title" : "New title"}</h2><button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setMetadataFor("draft")}>Find metadata for draft</button></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 12 }}>
            <div className="field">
              <label htmlFor="catalog-name">Name</label>
              <input id="catalog-name" required value={editor.name} onChange={(e) => { setEditor({ ...editor, name: e.target.value }); setDraftMetadata(null); }} />
            </div>
            <div className="field">
              <label htmlFor="catalog-type">Type</label>
              <select id="catalog-type" value={editor.type} onChange={(e) => { setEditor({ ...editor, type: e.target.value as "movie" | "series" }); setDraftMetadata(null); }}>
                <option value="movie">Movie</option>
                <option value="series">Series</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="catalog-year">Year</label>
              <input id="catalog-year" inputMode="numeric" value={editor.year} onChange={(e) => { setEditor({ ...editor, year: e.target.value }); setDraftMetadata(null); }} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="catalog-description">Description</label>
            <textarea id="catalog-description" rows={2} value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 12 }}>
            <div className="field">
              <label htmlFor="catalog-genres">Genres (comma separated)</label>
              <input id="catalog-genres" value={editor.genres} onChange={(e) => setEditor({ ...editor, genres: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="catalog-poster">Poster URL</label>
              <input id="catalog-poster" value={editor.posterUrl} onChange={(e) => setEditor({ ...editor, posterUrl: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="catalog-backdrop">Backdrop URL</label>
              <input id="catalog-backdrop" value={editor.backdropUrl} onChange={(e) => setEditor({ ...editor, backdropUrl: e.target.value })} />
            </div>
          </div>

          <h3 style={{ fontSize: 14, margin: "8px 0 10px" }}>
            Debrid sources <span className="dim">(hoster links or magnet URIs)</span>
          </h3>
          {editor.sources.map((s, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 8, marginBottom: 8 }}>
              <select value={s.kind} onChange={(e) => setSource(i, { kind: e.target.value as "link" | "magnet" })}>
                <option value="link">Link</option>
                <option value="magnet">Magnet</option>
              </select>
              <input placeholder="URL / magnet URI" value={s.url} onChange={(e) => setSource(i, { url: e.target.value })} />
              <input placeholder="Quality" value={s.quality ?? ""} onChange={(e) => setSource(i, { quality: e.target.value })} />
              <input placeholder="Label" value={s.label ?? ""} onChange={(e) => setSource(i, { label: e.target.value })} />
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setEditor({ ...editor, sources: editor.sources.filter((_, idx) => idx !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginBottom: 16 }}
            onClick={() => setEditor({ ...editor, sources: [...editor.sources, { kind: "link", url: "" }] })}
          >
            + Add source
          </button>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => { setEditor(null); setMetadataFor(null); }}>Cancel</button>
          </div>
        </form>
      )}

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Year</th><th>Genres</th><th>Sources</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {titles.map((title) => (
              <tr key={title.id}>
                <td>{title.name}</td>
                <td>{title.type}</td>
                <td className="dim">{title.year ?? "—"}</td>
                <td className="dim">{title.genres.join(", ")}</td>
                <td>{title.sources?.length ?? title.sourceCount}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => openEditor(title)}>Edit</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditor(null); setMetadataFor(title); setNotice(""); }} aria-label={`Find metadata for ${title.name}`}>Fix match</button>
                  <button className="btn btn-danger btn-sm" onClick={() => remove(title)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
