"use client";

import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "@/lib/api";
import { Title, TitleSource } from "@/lib/types";

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

  const load = useCallback(() => {
    get<{ titles: Title[] }>("/api/admin/catalog")
      .then((r) => setTitles(r.titles))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const openEditor = (title?: Title) => {
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
    if (!editor) return;
    setError(null);
    const payload = {
      name: editor.name,
      description: editor.description,
      type: editor.type,
      genres: editor.genres.split(",").map((g) => g.trim()).filter(Boolean),
      year: editor.year ? parseInt(editor.year, 10) : null,
      posterUrl: editor.posterUrl || null,
      backdropUrl: editor.backdropUrl || null,
      sources: editor.sources.filter((s) => s.url.trim() !== ""),
    };
    try {
      if (editor.id) await patch(`/api/admin/catalog/${editor.id}/update`, payload);
      else await post("/api/admin/catalog/create", payload);
      setEditor(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
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

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <span className="dim">{titles.length} titles</span>
        <button className="btn" onClick={() => openEditor()}>+ Add title</button>
      </div>
      {error && <p className="error-text">{error}</p>}

      {editor && (
        <form className="card" style={{ marginBottom: 24 }} onSubmit={save}>
          <h2 style={{ fontSize: 17, marginBottom: 16 }}>{editor.id ? "Edit title" : "New title"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
            <div className="field">
              <label>Name</label>
              <input required value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={editor.type} onChange={(e) => setEditor({ ...editor, type: e.target.value as "movie" | "series" })}>
                <option value="movie">Movie</option>
                <option value="series">Series</option>
              </select>
            </div>
            <div className="field">
              <label>Year</label>
              <input value={editor.year} onChange={(e) => setEditor({ ...editor, year: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Description</label>
            <textarea rows={2} value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div className="field">
              <label>Genres (comma separated)</label>
              <input value={editor.genres} onChange={(e) => setEditor({ ...editor, genres: e.target.value })} />
            </div>
            <div className="field">
              <label>Poster URL</label>
              <input value={editor.posterUrl} onChange={(e) => setEditor({ ...editor, posterUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>Backdrop URL</label>
              <input value={editor.backdropUrl} onChange={(e) => setEditor({ ...editor, backdropUrl: e.target.value })} />
            </div>
          </div>

          <h3 style={{ fontSize: 14, margin: "8px 0 10px" }}>
            Debrid sources <span className="dim">(hoster links or magnet URIs)</span>
          </h3>
          {editor.sources.map((s, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr 100px 140px 40px", gap: 8, marginBottom: 8 }}>
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
            <button className="btn">Save</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditor(null)}>Cancel</button>
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
