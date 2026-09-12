'use client';

import React, { useEffect, useState } from 'react';

type Tab =
  | 'overview'
  | 'pages'
  | 'text'
  | 'images'
  | 'chunks'
  | 'embeddings'
  | 'relationships'
  | 'graph'
  | 'search'
  | 'binary';

interface TopicItem {
  uid: string;
  fileName: string;
  filePath: string;
  topicName: string;
  fileSize: number;
  updatedTimestamp: number;
}

interface FnHeadingItem {
  text: string;
  level: number;
}

interface FnPageItem {
  pageNumber: number;
  text: string;
  headings?: FnHeadingItem[];
  subTopics?: Array<{ names: string[]; pageNumber: string | number }>;
}

interface FnAssetItem {
  id: string;
  pageNumber: number;
  filePath: string;
  mimeType: string;
  description?: string;
}

interface FnChunkItem {
  id: string;
  topicUid: string;
  pageNumber: number;
  section: string;
  sourceType: string;
  text: string;
  contentHash: string;
}

interface FnEmbeddingItem {
  id: string;
  chunkId: string;
  model: string;
  dimensions: number;
  modality: string;
  vector: number[];
}

interface FnRelationshipItem {
  id: string;
  fromId: string;
  toId: string;
  type: string;
}

interface FnContentData {
  header?: {
    magic?: string;
    schemaVersion?: number;
    topicUid?: string;
    createdTimestamp?: number;
    updatedTimestamp?: number;
  };
  topic?: {
    topicId?: string;
    topicName?: string;
  };
  document?: {
    pages?: FnPageItem[];
  };
  assets?: {
    images?: FnAssetItem[];
  };
  semantic?: {
    chunks?: FnChunkItem[];
    relationships?: FnRelationshipItem[];
  };
  rag?: {
    model?: string;
    dimensions?: number;
    embeddings?: FnEmbeddingItem[];
  };
}

interface ValidationData {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

interface BinaryInfoData {
  magic?: string;
  schemaVersion?: number;
  topicUid?: string;
  fileSize?: number;
  checksumValid?: boolean;
  sections?: Array<{ typeId: number; name: string; offset: number; length: number }>;
}

interface SearchResultItemData {
  rank: number;
  similarityScore: number;
  chunkId: string;
  topicName: string;
  pageNumber: number;
  section: string;
  text: string;
}

interface SearchResponseData {
  results?: SearchResultItemData[];
  queryEmbedding?: {
    model?: string;
    dimensions?: number;
  };
}

export default function FnInspectorPage() {
  const [isDev] = useState<boolean>(() => process.env.NODE_ENV === 'development');
  const [topicList, setTopicList] = useState<TopicItem[]>([]);
  const [selectedUid, setSelectedUid] = useState<string>('');
  const [fnContent, setFnContent] = useState<FnContentData | null>(null);
  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [binaryInfo, setBinaryInfo] = useState<BinaryInfoData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchResponseData | null>(null);
  const [relFilter, setRelFilter] = useState<string>('all');
  const [selectedEmbedding, setSelectedEmbedding] = useState<FnEmbeddingItem | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (!isDev) return;

    const loadTopicList = async () => {
      if (window.electronAPI?.fnInspector?.list) {
        const list = await window.electronAPI.fnInspector.list();
        setTopicList(list || []);
        if (list && list.length > 0 && !selectedUid) {
          setSelectedUid(list[0].uid);
        }
      }
    };

    void loadTopicList();
  }, [isDev, selectedUid]);

  useEffect(() => {
    if (!selectedUid || !window.electronAPI?.fnInspector) return;

    const loadData = async () => {
      const content = await window.electronAPI!.fnInspector!.inspect(selectedUid);
      setFnContent(content as FnContentData);

      const val = await window.electronAPI!.fnInspector!.validate(selectedUid);
      setValidation(val as ValidationData);

      const bin = await window.electronAPI!.fnInspector!.getBinaryInfo(selectedUid);
      setBinaryInfo(bin as BinaryInfoData);
    };

    void loadData();
  }, [selectedUid]);

  if (isDev === false) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-500">Access Denied</h1>
          <p className="mt-2 text-gray-400">The FN Inspector developer tool is only available in development mode.</p>
        </div>
      </div>
    );
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !window.electronAPI?.fnInspector?.search) return;

    const res = await window.electronAPI.fnInspector.search(searchQuery, {
      topK: 5,
      uid: selectedUid || undefined,
    });
    setSearchResults(res as SearchResponseData);
  };

  const copyVector = (vec: number[]) => {
    void navigator.clipboard.writeText(JSON.stringify(vec, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const pages: FnPageItem[] = fnContent?.document?.pages || [];
  const chunks: FnChunkItem[] = fnContent?.semantic?.chunks || [];
  const embeddings: FnEmbeddingItem[] = fnContent?.rag?.embeddings || [];
  const relationships: FnRelationshipItem[] = fnContent?.semantic?.relationships || [];
  const images: FnAssetItem[] = fnContent?.assets?.images || [];

  const filteredRelationships = relFilter === 'all'
    ? relationships
    : relationships.filter((r) => r.type === relFilter);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono p-6 flex flex-col gap-6">
      {/* Top Header & Topic Picker */}
      <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded">DEV ONLY</span>
            <h1 className="text-xl font-bold tracking-tight text-white">FluxNotes .fn Binary Inspector</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">Visually inspect decoded binary layout, chunks, vector embeddings, and knowledge graph</p>
        </div>

        <div className="flex items-center gap-3 bg-slate-900 p-2 rounded-lg border border-slate-800">
          <label className="text-xs font-medium text-slate-400">Topic .fn:</label>
          <select
            value={selectedUid}
            onChange={(e) => setSelectedUid(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-xs text-slate-200 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            {topicList.length === 0 ? (
              <option value="">No .fn files found</option>
            ) : (
              topicList.map((t) => (
                <option key={t.uid} value={t.uid}>
                  {t.topicName} ({t.uid.substring(0, 8)}.fn)
                </option>
              ))
            )}
          </select>
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex flex-wrap gap-1 border-b border-slate-800 pb-2 text-xs">
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'pages', label: `Pages (${pages.length})` },
          { id: 'text', label: 'Extracted Text' },
          { id: 'images', label: `Images (${images.length})` },
          { id: 'chunks', label: `Chunks (${chunks.length})` },
          { id: 'embeddings', label: `Embeddings (${embeddings.length})` },
          { id: 'relationships', label: `Relationships (${relationships.length})` },
          { id: 'graph', label: 'Knowledge Graph' },
          { id: 'search', label: 'Retrieval Debugger' },
          { id: 'binary', label: 'Raw Binary Info' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as Tab)}
            className={`px-3 py-1.5 rounded transition ${
              activeTab === tab.id
                ? 'bg-emerald-600 text-white font-medium shadow'
                : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <main className="flex-1 bg-slate-900/50 border border-slate-800 rounded-xl p-6">
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg space-y-2 text-xs">
                <h3 className="font-bold text-slate-300 text-sm border-b border-slate-800 pb-2">Topic Metadata</h3>
                <p><span className="text-slate-500">Topic Title:</span> <span className="text-slate-200">{fnContent?.topic?.topicName || 'N/A'}</span></p>
                <p><span className="text-slate-500">Topic UID:</span> <span className="text-slate-200">{fnContent?.header?.topicUid || 'N/A'}</span></p>
                <p><span className="text-slate-500">Schema Version:</span> <span className="text-slate-200">{fnContent?.header?.schemaVersion || 'N/A'}</span></p>
                <p><span className="text-slate-500">File Size:</span> <span className="text-slate-200">{binaryInfo?.fileSize ? `${(binaryInfo.fileSize / 1024).toFixed(2)} KB` : 'N/A'}</span></p>
                <p><span className="text-slate-500">Created:</span> <span className="text-slate-200">{fnContent?.header?.createdTimestamp ? new Date(fnContent.header.createdTimestamp).toLocaleString() : 'N/A'}</span></p>
                <p><span className="text-slate-500">Updated:</span> <span className="text-slate-200">{fnContent?.header?.updatedTimestamp ? new Date(fnContent.header.updatedTimestamp).toLocaleString() : 'N/A'}</span></p>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg space-y-2 text-xs">
                <h3 className="font-bold text-slate-300 text-sm border-b border-slate-800 pb-2">Vector & RAG Configuration</h3>
                <p><span className="text-slate-500">Embedding Model:</span> <span className="text-slate-200">{fnContent?.rag?.model || 'N/A'}</span></p>
                <p><span className="text-slate-500">Dimensions:</span> <span className="text-slate-200">{fnContent?.rag?.dimensions || 'N/A'}</span></p>
                <p><span className="text-slate-500">Total Chunks:</span> <span className="text-slate-200">{chunks.length}</span></p>
                <p><span className="text-slate-500">Total Embeddings:</span> <span className="text-slate-200">{embeddings.length}</span></p>
                <p><span className="text-slate-500">Total Relationships:</span> <span className="text-slate-200">{relationships.length}</span></p>
              </div>
            </div>

            {/* Health Checklist */}
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg space-y-3">
              <h3 className="font-bold text-slate-300 text-sm border-b border-slate-800 pb-2">.fn Binary File Health</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={validation?.valid ? 'text-emerald-400' : 'text-red-400'}>{validation?.valid ? '✓' : '✕'}</span>
                  <span>Binary Magic Header & Format Valid</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={binaryInfo?.checksumValid ? 'text-emerald-400' : 'text-amber-400'}>{binaryInfo?.checksumValid ? '✓' : '⚠'}</span>
                  <span>SHA-256 Binary Integrity Checksum</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={(validation?.warnings?.length || 0) === 0 ? 'text-emerald-400' : 'text-amber-400'}>
                    {(validation?.warnings?.length || 0) === 0 ? '✓' : '⚠'}
                  </span>
                  <span>No Orphan Chunks / Embeddings</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={(validation?.errors?.length || 0) === 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {(validation?.errors?.length || 0) === 0 ? '✓' : '✕'}
                  </span>
                  <span>Vector Dimensions Consistent</span>
                </div>
              </div>

              {(validation?.errors?.length || 0) > 0 && (
                <div className="mt-3 p-3 bg-red-950/40 border border-red-800/50 rounded text-xs text-red-300">
                  <p className="font-semibold text-red-400">Validation Errors:</p>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    {validation?.errors?.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {(validation?.warnings?.length || 0) > 0 && (
                <div className="mt-3 p-3 bg-amber-950/40 border border-amber-800/50 rounded text-xs text-amber-300">
                  <p className="font-semibold text-amber-400">Validation Warnings:</p>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    {validation?.warnings?.map((warn, i) => (
                      <li key={i}>{warn}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* PAGES TAB */}
        {activeTab === 'pages' && (
          <div className="space-y-4">
            {pages.length === 0 ? (
              <p className="text-slate-500 text-xs">No pages recorded in this .fn container.</p>
            ) : (
              pages.map((p) => (
                <div key={p.pageNumber} className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-xs space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="font-bold text-emerald-400">Page {p.pageNumber}</span>
                    <span className="text-slate-500">{p.subTopics?.length || 0} Subtopics</span>
                  </div>
                  <div>
                    <span className="text-slate-400 font-medium">Headings:</span>
                    <ul className="list-disc list-inside mt-1 text-slate-300">
                      {p.headings?.map((h, i) => (
                        <li key={i}>{h.text} (Level {h.level})</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <span className="text-slate-400 font-medium">Text Preview:</span>
                    <p className="mt-1 p-2 bg-slate-950 rounded text-slate-300 whitespace-pre-wrap">{p.text}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* TEXT TAB */}
        {activeTab === 'text' && (
          <div className="space-y-4">
            <h3 className="font-bold text-slate-300 text-sm">Full Document Text</h3>
            <pre className="p-4 bg-slate-950 rounded border border-slate-800 text-xs text-slate-300 whitespace-pre-wrap font-mono">
              {pages.map((p) => `--- PAGE ${p.pageNumber} ---\n${p.text}\n`).join('\n')}
            </pre>
          </div>
        )}

        {/* IMAGES TAB */}
        {activeTab === 'images' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {images.length === 0 ? (
              <p className="text-slate-500 text-xs">No image assets in this .fn file.</p>
            ) : (
              images.map((img) => (
                <div key={img.id} className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-emerald-400">{img.id}</span>
                    <span className="text-slate-500">Page {img.pageNumber}</span>
                  </div>
                  <p><span className="text-slate-500">File Path:</span> <span className="text-slate-300 break-all">{img.filePath}</span></p>
                  <p><span className="text-slate-500">MIME Type:</span> <span className="text-slate-300">{img.mimeType}</span></p>
                  {img.description && <p><span className="text-slate-500">Description:</span> <span className="text-slate-300">{img.description}</span></p>}
                </div>
              ))
            )}
          </div>
        )}

        {/* CHUNKS TAB */}
        {activeTab === 'chunks' && (
          <div className="space-y-3">
            {chunks.length === 0 ? (
              <p className="text-slate-500 text-xs">No chunks extracted.</p>
            ) : (
              chunks.map((c) => (
                <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-1">
                    <span className="font-bold text-emerald-400">{c.id}</span>
                    <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300 text-[10px] uppercase">{c.sourceType}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-slate-400 text-[11px]">
                    <p>Page: {c.pageNumber}</p>
                    <p>Section: {c.section}</p>
                    <p className="col-span-2 break-all">Hash: {c.contentHash}</p>
                  </div>
                  <p className="p-2 bg-slate-950 rounded text-slate-200 mt-1">{c.text}</p>
                </div>
              ))
            )}
          </div>
        )}

        {/* EMBEDDINGS TAB */}
        {activeTab === 'embeddings' && (
          <div className="space-y-6">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-900 border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="p-2">Embedding ID</th>
                    <th className="p-2">Chunk ID</th>
                    <th className="p-2">Dimensions</th>
                    <th className="p-2">Model</th>
                    <th className="p-2">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {embeddings.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-800/40 cursor-pointer" onClick={() => setSelectedEmbedding(e)}>
                      <td className="p-2 font-mono text-emerald-400">{e.id}</td>
                      <td className="p-2">{e.chunkId}</td>
                      <td className="p-2">{e.dimensions || e.vector?.length}</td>
                      <td className="p-2 text-slate-400">{e.model}</td>
                      <td className="p-2">
                        <button className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-[10px]">View Vector</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedEmbedding && (
              <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <h4 className="font-bold text-white text-xs">Vector Data: {selectedEmbedding.id}</h4>
                  <button
                    onClick={() => copyVector(selectedEmbedding.vector)}
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] rounded font-medium"
                  >
                    {copied ? 'Copied!' : 'Copy Float Array'}
                  </button>
                </div>

                {/* Vector Bar Visualization */}
                <div>
                  <p className="text-[10px] text-slate-400 mb-1">Vector Heatmap Visualization (first 64 dimensions):</p>
                  <div className="flex gap-0.5 h-6 bg-slate-950 p-1 rounded overflow-hidden">
                    {(selectedEmbedding.vector || []).slice(0, 64).map((v: number, i: number) => {
                      const height = Math.min(100, Math.max(10, Math.abs(v) * 500));
                      const isNeg = v < 0;
                      return (
                        <div
                          key={i}
                          style={{ height: `${height}%` }}
                          title={`Dim ${i}: ${v}`}
                          className={`flex-1 rounded-sm ${isNeg ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        />
                      );
                    })}
                  </div>
                </div>

                <div className="max-h-48 overflow-y-auto bg-slate-950 p-3 rounded font-mono text-[11px] text-slate-300">
                  [{selectedEmbedding.vector?.join(', ')}]
                </div>
              </div>
            )}
          </div>
        )}

        {/* RELATIONSHIPS TAB */}
        {activeTab === 'relationships' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400">Filter by Relationship Type:</label>
              <select
                value={relFilter}
                onChange={(e) => setRelFilter(e.target.value)}
                className="bg-slate-950 border border-slate-700 text-xs rounded px-2.5 py-1"
              >
                <option value="all">All Types</option>
                <option value="contains">contains</option>
                <option value="references">references</option>
                <option value="belongs_to">belongs_to</option>
                <option value="derived_from">derived_from</option>
                <option value="describes">describes</option>
                <option value="illustrates">illustrates</option>
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-900 border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="p-2">FROM</th>
                    <th className="p-2">RELATIONSHIP</th>
                    <th className="p-2">TO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 font-mono">
                  {filteredRelationships.map((r) => (
                    <tr key={r.id}>
                      <td className="p-2 text-emerald-400">{r.fromId}</td>
                      <td className="p-2 font-semibold text-amber-400">{r.type}</td>
                      <td className="p-2 text-cyan-400">{r.toId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* KNOWLEDGE GRAPH TAB */}
        {activeTab === 'graph' && (
          <div className="space-y-4">
            <h3 className="font-bold text-slate-300 text-sm">Visual Knowledge Structure</h3>
            <div className="p-6 bg-slate-950 border border-slate-800 rounded-lg space-y-4 font-mono text-xs">
              <div className="text-center p-2 bg-emerald-950/60 border border-emerald-700 rounded text-emerald-300 max-w-sm mx-auto">
                Topic: {fnContent?.topic?.topicName || 'Root'} ({selectedUid.substring(0, 8)})
              </div>
              <div className="w-0.5 h-4 bg-slate-700 mx-auto" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pages.map((p) => (
                  <div key={p.pageNumber} className="p-3 bg-slate-900 border border-slate-800 rounded space-y-2">
                    <div className="font-bold text-slate-200">Page {p.pageNumber}</div>
                    <div className="pl-3 border-l-2 border-emerald-500/50 space-y-1 text-[11px]">
                      {chunks.filter((c) => c.pageNumber === p.pageNumber).map((c) => (
                        <div key={c.id} className="text-slate-400">
                          └─ Chunk: <span className="text-emerald-400">{c.id}</span> ({c.sourceType})
                        </div>
                      ))}
                      {images.filter((i) => i.pageNumber === p.pageNumber).map((i) => (
                        <div key={i.id} className="text-slate-400">
                          └─ Image: <span className="text-cyan-400">{i.id}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* RETRIEVAL DEBUGGER TAB */}
        {activeTab === 'search' && (
          <div className="space-y-6">
            <form onSubmit={(e) => { void handleSearch(e); }} className="flex gap-2">
              <input
                type="text"
                placeholder="Search your .fn files (e.g. How does AC generator work?)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-slate-950 border border-slate-700 text-xs px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 text-white"
              />
              <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded">
                Search
              </button>
            </form>

            {searchResults && (
              <div className="space-y-4">
                <div className="p-3 bg-slate-900 border border-slate-800 rounded text-xs space-y-1">
                  <p><span className="text-slate-500">Query Model:</span> <span className="text-slate-300">{searchResults.queryEmbedding?.model}</span></p>
                  <p><span className="text-slate-500">Dimensions:</span> <span className="text-slate-300">{searchResults.queryEmbedding?.dimensions}</span></p>
                </div>

                <div className="space-y-3">
                  {searchResults.results?.map((res) => (
                    <div key={res.chunkId} className="p-4 bg-slate-900 border border-slate-800 rounded-lg text-xs space-y-2">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-1">
                        <span className="font-bold text-amber-400">Rank #{res.rank}</span>
                        <span className="text-emerald-400 font-semibold">Cosine Score: {res.similarityScore.toFixed(4)}</span>
                      </div>
                      <p><span className="text-slate-500">Topic:</span> {res.topicName} | <span className="text-slate-500">Page:</span> {res.pageNumber} | <span className="text-slate-500">Section:</span> {res.section}</p>
                      <p className="p-2 bg-slate-950 rounded text-slate-200 mt-1">{res.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* RAW BINARY INFO TAB */}
        {activeTab === 'binary' && (
          <div className="space-y-4">
            <h3 className="font-bold text-slate-300 text-sm">Low-Level Binary Structure</h3>
            <div className="p-4 bg-slate-950 border border-slate-800 rounded font-mono text-xs space-y-2">
              <p><span className="text-slate-500">Magic Header:</span> <span className="text-emerald-400">{binaryInfo?.magic}</span></p>
              <p><span className="text-slate-500">Schema Version:</span> <span className="text-slate-300">{binaryInfo?.schemaVersion}</span></p>
              <p><span className="text-slate-500">Topic UID:</span> <span className="text-slate-300">{binaryInfo?.topicUid}</span></p>
              <p><span className="text-slate-500">File Size:</span> <span className="text-slate-300">{binaryInfo?.fileSize} bytes</span></p>
              <p><span className="text-slate-500">Checksum Status:</span> <span className={binaryInfo?.checksumValid ? 'text-emerald-400' : 'text-red-400'}>{binaryInfo?.checksumValid ? 'Valid SHA-256' : 'Invalid'}</span></p>
            </div>

            <h4 className="font-bold text-slate-300 text-xs mt-4">Section Offset & Length Table</h4>
            <table className="w-full text-left text-xs text-slate-300 border border-slate-800">
              <thead className="bg-slate-900 border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="p-2">Type ID</th>
                  <th className="p-2">Section Name</th>
                  <th className="p-2">Offset (Bytes)</th>
                  <th className="p-2">Length (Bytes)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 font-mono">
                {(binaryInfo?.sections || []).map((s) => (
                  <tr key={s.typeId}>
                    <td className="p-2 text-slate-400">{s.typeId}</td>
                    <td className="p-2 text-emerald-400">{s.name}</td>
                    <td className="p-2">{s.offset}</td>
                    <td className="p-2">{s.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
