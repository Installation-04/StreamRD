import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { TopNav } from '../components/TopNav';
import { TvButton } from '../components/TvButton';
import { StatusPill, ProgressBar } from '../components/StatusBits';
import { colors, type } from '../theme';
import { formatBytes } from '../format';
import { del, get, post, DownloadJob } from '../api';

const POLL_MS = 4000;

export function DownloadsScreen({
  onNavigate,
  onSignOut,
  onPlay,
}: {
  onNavigate: (screen: 'search' | 'downloads') => void;
  onSignOut: () => void;
  onPlay: (job: DownloadJob) => void;
}) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const jobsRef = useRef<DownloadJob[]>([]);
  jobsRef.current = jobs;

  const load = useCallback(async () => {
    try {
      const res = await get<{ jobs: DownloadJob[] }>('/api/downloads');
      setJobs(res.jobs);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll active jobs so progress bars and "finished" transitions update without user input.
  useEffect(() => {
    const id = setInterval(async () => {
      const active = jobsRef.current.filter((j) => j.status === 'queued' || j.status === 'downloading');
      if (active.length === 0) return;
      const updates = await Promise.allSettled(
        active.map((j) => post<{ job: DownloadJob }>(`/api/downloads/${j.id}/refresh`))
      );
      setJobs((prev) => {
        const byId = new Map(prev.map((j) => [j.id, j]));
        updates.forEach((u, i) => {
          const jobId = active[i].id;
          if (u.status === 'fulfilled') byId.set(jobId, u.value.job);
        });
        return prev.map((j) => byId.get(j.id) ?? j);
      });
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const refreshOne = (job: DownloadJob) =>
    withBusy(job.id, async () => {
      try {
        const res = await post<{ job: DownloadJob }>(`/api/downloads/${job.id}/refresh`);
        setJobs((prev) => prev.map((j) => (j.id === job.id ? res.job : j)));
      } catch (err) {
        setError((err as Error).message);
      }
    });

  const removeOne = (job: DownloadJob) =>
    withBusy(job.id, async () => {
      try {
        await del(`/api/downloads/${job.id}`);
        setJobs((prev) => prev.filter((j) => j.id !== job.id));
      } catch (err) {
        setError((err as Error).message);
      }
    });

  return (
    <View style={s.screen}>
      <TopNav active="downloads" onNavigate={onNavigate} onSignOut={onSignOut} />
      <View style={s.body}>
        <View style={s.headerRow}>
          <Text style={type.h1}>DOWNLOAD QUEUE</Text>
          <TvButton label="Refresh list" secondary onPress={load} />
        </View>
        {error ? <Text style={[type.body, { color: colors.red, marginBottom: 8 }]}>{error.toUpperCase()}</Text> : null}
        {loading ? (
          <Text style={type.dim}>LOADING...</Text>
        ) : jobs.length === 0 ? (
          <Text style={type.dim}>QUEUE IS EMPTY — ADD SOMETHING FROM SEARCH</Text>
        ) : (
          <FlatList
            data={jobs}
            keyExtractor={(j) => j.id}
            renderItem={({ item }) => {
              const busy = busyIds.has(item.id);
              return (
                <View style={s.row}>
                  <View style={s.info}>
                    <Text style={type.body} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={type.dim}>
                      {formatBytes(item.sizeBytes)} · {item.seeders} SEEDERS · {item.indexerName ?? 'UNKNOWN'} · {item.provider.toUpperCase()}
                    </Text>
                    <View style={s.statusRow}>
                      <StatusPill status={item.status} />
                      {item.status === 'downloading' || item.status === 'queued' ? (
                        <ProgressBar progress={item.progress} />
                      ) : null}
                    </View>
                    {item.error ? <Text style={[type.dim, { color: colors.red }]}>{item.error}</Text> : null}
                  </View>
                  <View style={s.actions}>
                    {item.status === 'finished' && item.streamUrl ? (
                      <TvButton label="Play" onPress={() => onPlay(item)} disabled={busy} />
                    ) : null}
                    {item.status !== 'finished' ? (
                      <TvButton label="Refresh" secondary onPress={() => refreshOne(item)} disabled={busy} />
                    ) : null}
                    <TvButton label="Remove" danger onPress={() => removeOne(item)} disabled={busy} />
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, padding: 24 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.phosphorFaint,
    paddingVertical: 12,
    gap: 16,
  },
  info: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
});
