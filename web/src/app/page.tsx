"use client";

import { useEffect, useState } from "react";
import { ApiError, get } from "@/lib/api";
import { t } from "@/lib/i18n";
import { CatalogRow } from "@/lib/types";
import { TitleRow } from "@/components/TitleCard";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    get<{ rows: CatalogRow[] }>("/api/catalog/rows")
      .then((res) => setRows(res.rows))
      .catch((err: ApiError) => {
        if (err.status === 401) router.push("/login");
        else setError(err.message);
      });
  }, [router]);

  return (
    <main className="container">
      {error && <p className="error-text">{error}</p>}
      {rows && rows.length === 0 && <p className="dim" style={{ marginTop: 40 }}>{t("home.empty")}</p>}
      {rows?.map((row) => (
        <TitleRow key={row.id} label={row.label} titles={row.titles} />
      ))}
    </main>
  );
}
