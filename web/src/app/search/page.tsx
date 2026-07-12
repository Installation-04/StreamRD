"use client";

import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Title } from "@/lib/types";
import { TitleCard } from "@/components/TitleCard";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Title[]>([]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      get<{ results: Title[] }>(`/api/catalog/search?q=${encodeURIComponent(query)}`)
        .then((res) => setResults(res.results))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <main className="container">
      <div className="field" style={{ marginTop: 32 }}>
        <input
          autoFocus
          placeholder={t("search.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="row-scroller" style={{ flexWrap: "wrap" }}>
        {results.map((title) => (
          <TitleCard key={title.id} title={title} />
        ))}
      </div>
    </main>
  );
}
