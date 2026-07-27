import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { TopNav } from '../components/TopNav';
import { Panel } from '../components/Panel';
import { TvButton } from '../components/TvButton';
import { TvTextInput } from '../components/TvTextInput';
import { colors, type } from '../theme';
import { formatBytes } from '../format';
import { get, post, DownloadJob, SearchResponse, SearchResult } from '../api';

type SortKey = 'seeders' | 'size' | 'date';

export function SearchScreen({
  onNavigate,
  onSignOut,
  onOpenQueue,
}: {
  onNavigate: (screen: 'search' | 'downloads') => void;
  onSignOut: () => void;
  onOpenQueue: () => void;
}) {
  const [query, setQuery] = useState('');
  const [minSeeders, setMinSeeders] = useState('');
  const [maxSizeGb, setMaxSizeGb] = useState('');
  const [sort, setSort] = useState<SortKey>('seeders');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setBanner(null);
    try {
      const params = new URLSearchParams({ q: query.trim(), sort });
      if (minSeeders.trim()) params.set('minSeeders', minSeeders.trim());
      if (maxSizeGb.trim()) params.set('maxSizeGb', maxSizeGb.trim());
      const res = await get<SearchResponse>(`/api/search?${params.toString()}`);
      setResults(res.results.filter((r) => r.hasMagnet));
      setErrors(res.errors);
      setSearched(true);
    } catch (err) {
      setErrors([(err as Error).message]);
      setResults([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  }, [query, minSeeders, maxSizeGb, sort]);

  const addResult = async (item: SearchResult, key: string) => {
    setAddingKey(key);
    setBanner(null);
    try {
      const job = await post<{ job: DownloadJob }>('/api/downloads', {
        title: item.title,
        sourceUrl: item.link,
        sizeBytes: item.sizeBytes,
        seeders: item.seeders,
        indexerName: item.indexerName,
      });
      setAddedKeys((prev) => new Set(prev).add(key));
      setBanner(
        job.job.status === 'finished'
          ? `"${item.title}" ADDED — ALREADY CACHED, READY IN QUEUE`
          : `"${item.title}" ADDED TO QUEUE`
      );
    } catch (err) {
      setBanner(`ADD FAILED: ${(err as Error).message}`);
    } finally {
      setAddingKey(null);
    }
  };

  return (
    <View style={s.screen}>
      <TopNav active="search" onNavigate={onNavigate} onSignOut={onSignOut} />
      <View style={s.body}>
        <Panel title="Search indexers" style={s.searchPanel}>
          <TvTextInput
            label="Query"
            value={query}
            onChangeText={setQuery}
            placeholder="e.g. big buck bunny 1080p"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={runSearch}
          />
          <View style={s.filterRow}>
            <View style={s.filterCol}>
              <TvTextInput
                label="Min seeders"
                value={minSeeders}
                onChangeText={setMinSeeders}
                keyboardType="numeric"
                placeholder="0"
              />
            </View>
            <View style={s.filterCol}>
              <TvTextInput
                label="Max size (GB)"
                value={maxSizeGb}
                onChangeText={setMaxSizeGb}
                keyboardType="numeric"
                placeholder="any"
              />
            </View>
          </View>
          <Text style={type.dim}>SORT BY</Text>
          <View style={s.sortRow}>
            {(['seeders', 'size', 'date'] as SortKey[]).map((k) => (
              <TvButton key={k} label={k} secondary={sort !== k} onPress={() => setSort(k)} />
            ))}
          </View>
          <TvButton label={searching ? 'Searching...' : 'Run search'} autoFocus onPress={runSearch} disabled={searching} />
        </Panel>

        <View style={s.resultsCol}>
          {banner ? <Text style={[type.body, { color: colors.phosphor, marginBottom: 8 }]}>{banner.toUpperCase()}</Text> : null}
          {errors.map((e, i) => (
            <Text key={i} style={[type.dim, { color: colors.amberWarn, marginBottom: 4 }]}>
              ! {e}
            </Text>
          ))}
          {searched && results.length === 0 && errors.length === 0 ? (
            <Text style={type.dim}>NO RESULTS WITH A USABLE MAGNET LINK</Text>
          ) : null}
          <FlatList
            data={results}
            keyExtractor={(item, idx) => `${item.indexerId}-${idx}-${item.link}`}
            renderItem={({ item, index }) => {
              const key = `${item.indexerId}-${index}-${item.link}`;
              const added = addedKeys.has(key);
              return (
                <View style={s.resultRow}>
                  <View style={s.resultInfo}>
                    <Text style={type.body} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={type.dim}>
                      {formatBytes(item.sizeBytes)} · {item.seeders} SEEDERS · {item.peers} PEERS · {item.indexerName}
                    </Text>
                  </View>
                  <TvButton
                    label={added ? 'Added' : addingKey === key ? 'Adding...' : 'Add'}
                    disabled={added || addingKey === key}
                    onPress={() => addResult(item, key)}
                  />
                </View>
              );
            }}
            style={{ flex: 1 }}
          />
          <TvButton label="View queue" secondary onPress={onOpenQueue} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, flexDirection: 'row', padding: 24, gap: 20 },
  searchPanel: { width: 400 },
  filterRow: { flexDirection: 'row', gap: 12 },
  filterCol: { flex: 1 },
  sortRow: { flexDirection: 'row', gap: 8, marginBottom: 16, marginTop: 6 },
  resultsCol: { flex: 1 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.phosphorFaint,
    paddingVertical: 10,
    gap: 12,
  },
  resultInfo: { flex: 1 },
});
