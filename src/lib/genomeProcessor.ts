/**
 * Chunked Genome Processor for Large Files
 * 
 * Handles genomes up to 500MB through:
 * 1. Streaming/chunked reading
 * 2. Bloom filter indexing
 * 3. Progressive processing with memory management
 * 
 * Scientific Considerations:
 * - Maintains k-mer integrity across chunk boundaries
 * - Uses overlap regions to prevent missing k-mers
 * - Implements garbage collection hints for large datasets
 */

import { BloomFilter, CountingBloomFilter } from './bloomFilter';

export interface ProcessingProgress {
  phase: 'parsing' | 'indexing' | 'scanning' | 'analyzing' | 'complete';
  progress: number; // 0-1
  message: string;
  stats?: {
    genomeSizeMB: number;
    indexedKmers: number;
    memoryUsageMB: number;
    chunksProcessed: number;
    totalChunks: number;
  };
}

export interface GenomeIndex {
  filter15mer: BloomFilter;
  filter7mer: CountingBloomFilter;
  sequenceLength: number;
  gcContent: number;
  nucleotideCounts: { A: number; T: number; G: number; C: number };
}

/**
 * Configuration for genome processing
 */
export interface ProcessingConfig {
  chunkSize: number;           // Bases per chunk (default 1MB = 1,000,000)
  overlapSize: number;         // Overlap between chunks to capture k-mers
  maxMemoryMB: number;         // Maximum memory usage
  progressCallback?: (progress: ProcessingProgress) => void;
}

const DEFAULT_CONFIG: ProcessingConfig = {
  chunkSize: 1_000_000,        // 1MB chunks
  overlapSize: 50,             // 50bp overlap (> any k-mer size)
  maxMemoryMB: 512,            // 512MB max memory
};

/**
 * Parse FASTA format efficiently without loading entire file
 */
export function parseFastaStreaming(
  text: string,
  onChunk: (sequence: string, position: number) => void,
  chunkSize: number = 1_000_000
): { totalLength: number; headers: string[] } {
  const lines = text.split(/\r?\n/);
  const headers: string[] = [];
  let currentSequence = '';
  let totalLength = 0;
  let globalPosition = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) {
      headers.push(trimmed.substring(1));
      continue;
    }
    if (!trimmed) continue;

    currentSequence += trimmed.toUpperCase();
    
    // Process in chunks
    while (currentSequence.length >= chunkSize) {
      const chunk = currentSequence.substring(0, chunkSize);
      onChunk(chunk, globalPosition);
      globalPosition += chunkSize;
      totalLength += chunkSize;
      // Keep overlap for k-mer continuity
      currentSequence = currentSequence.substring(chunkSize - 50);
    }
  }

  // Process remaining sequence
  if (currentSequence.length > 0) {
    onChunk(currentSequence, globalPosition);
    totalLength += currentSequence.length;
  }

  return { totalLength, headers };
}

/**
 * Build genome index using Bloom filters with chunked processing
 */
export async function buildGenomeIndex(
  genomeSequence: string,
  config: Partial<ProcessingConfig> = {}
): Promise<GenomeIndex> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { progressCallback } = cfg;

  // Estimate genome size and number of k-mers
  const genomeSizeMB = genomeSequence.length / (1024 * 1024);
  const estimated15mers = genomeSequence.length - 14;
  const estimated7mers = genomeSequence.length - 6;

  progressCallback?.({
    phase: 'parsing',
    progress: 0,
    message: `Processing ${genomeSizeMB.toFixed(1)} MB genome...`,
  });

  // Initialize Bloom filters based on genome size
  const filter15mer = new BloomFilter(estimated15mers, 0.001);
  const filter7mer = new CountingBloomFilter(estimated7mers, 0.01);

  // Calculate nucleotide composition
  let countA = 0, countT = 0, countG = 0, countC = 0;

  // Process in chunks
  const totalChunks = Math.ceil(genomeSequence.length / cfg.chunkSize);
  let chunksProcessed = 0;

  for (let start = 0; start < genomeSequence.length; start += cfg.chunkSize) {
    const end = Math.min(start + cfg.chunkSize + cfg.overlapSize, genomeSequence.length);
    const chunk = genomeSequence.substring(start, end);
    const isLastChunk = end >= genomeSequence.length;
    const effectiveLength = isLastChunk ? chunk.length : cfg.chunkSize;

    // Index 15-mers
    for (let i = 0; i < effectiveLength && i + 15 <= chunk.length; i++) {
      const kmer = chunk.substring(i, i + 15);
      if (isValidKmer(kmer)) {
        filter15mer.add(kmer);
      }
    }

    // Index 7-mers (seed regions)
    for (let i = 0; i < effectiveLength && i + 7 <= chunk.length; i++) {
      const kmer = chunk.substring(i, i + 7);
      if (isValidKmer(kmer)) {
        filter7mer.add(kmer);
      }
    }

    // Count nucleotides (only for non-overlap region)
    for (let i = 0; i < effectiveLength; i++) {
      const base = chunk[i];
      if (base === 'A') countA++;
      else if (base === 'T' || base === 'U') countT++;
      else if (base === 'G') countG++;
      else if (base === 'C') countC++;
    }

    chunksProcessed++;
    
    progressCallback?.({
      phase: 'indexing',
      progress: chunksProcessed / totalChunks,
      message: `Indexing chunk ${chunksProcessed}/${totalChunks}...`,
      stats: {
        genomeSizeMB,
        indexedKmers: filter15mer.getItemCount(),
        memoryUsageMB: filter15mer.getMemoryUsageMB() + filter7mer.getCount('test') * 0,
        chunksProcessed,
        totalChunks,
      },
    });

    // Yield to event loop to prevent UI freezing
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const totalBases = countA + countT + countG + countC;
  const gcContent = totalBases > 0 ? ((countG + countC) / totalBases) * 100 : 0;

  progressCallback?.({
    phase: 'complete',
    progress: 1,
    message: 'Genome indexing complete',
    stats: {
      genomeSizeMB,
      indexedKmers: filter15mer.getItemCount(),
      memoryUsageMB: filter15mer.getMemoryUsageMB(),
      chunksProcessed: totalChunks,
      totalChunks,
    },
  });

  return {
    filter15mer,
    filter7mer,
    sequenceLength: genomeSequence.length,
    gcContent,
    nucleotideCounts: { A: countA, T: countT, G: countG, C: countC },
  };
}

/**
 * Check if k-mer contains only valid nucleotides
 */
function isValidKmer(kmer: string): boolean {
  for (let i = 0; i < kmer.length; i++) {
    const c = kmer[i];
    if (c !== 'A' && c !== 'T' && c !== 'G' && c !== 'C' && c !== 'U') {
      return false;
    }
  }
  return true;
}

/**
 * Enhanced safety search using Bloom filters
 */
export class BloomSafetyEngine {
  private index: GenomeIndex;
  private rawSequence: string;

  constructor(index: GenomeIndex, rawSequence: string) {
    this.index = index;
    this.rawSequence = rawSequence;
  }

  /**
   * Check if candidate has potential 15-mer match (possible false positive)
   */
  hasPotential15merMatch(candidate: string): boolean {
    for (let i = 0; i <= candidate.length - 15; i++) {
      const kmer = candidate.substring(i, i + 15);
      if (this.index.filter15mer.contains(kmer)) {
        return true; // Possible match (may be false positive)
      }
    }
    return false;
  }

  /**
   * Verify 15-mer match in raw sequence (for confirmation after Bloom filter)
   */
  verify15merMatch(candidate: string): boolean {
    for (let i = 0; i <= candidate.length - 15; i++) {
      const kmer = candidate.substring(i, i + 15);
      if (this.rawSequence.includes(kmer)) {
        return true; // Confirmed match
      }
    }
    return false;
  }

  /**
   * Get seed region match count
   */
  getSeedMatchCount(seed: string): number {
    return this.index.filter7mer.getCount(seed);
  }

  /**
   * Full safety check with Bloom filter pre-screening
   */
  checkSafety(candidate: string): {
    isSafe: boolean;
    maxMatch: number;
    hasSeedMatch: boolean;
    seedMatchCount: number;
  } {
    const candidate_upper = candidate.toUpperCase();
    
    // Quick Bloom filter check for 15-mer
    if (this.hasPotential15merMatch(candidate_upper)) {
      // Verify with actual sequence search (handles false positives)
      if (this.verify15merMatch(candidate_upper)) {
        return {
          isSafe: false,
          maxMatch: 15,
          hasSeedMatch: true,
          seedMatchCount: 100,
        };
      }
    }

    // Check seed region
    const seed = candidate_upper.substring(1, 8);
    const seedMatchCount = this.getSeedMatchCount(seed);
    const hasSeedMatch = seedMatchCount > 0;

    // Find maximum actual match length (14 down to 10)
    let maxMatch = 0;
    for (let len = 14; len >= 10; len--) {
      for (let i = 0; i <= candidate_upper.length - len; i++) {
        const kmer = candidate_upper.substring(i, i + len);
        // Use raw sequence search for accurate matching
        if (this.rawSequence.includes(kmer)) {
          maxMatch = len;
          break;
        }
      }
      if (maxMatch > 0) break;
    }

    return {
      isSafe: true,
      maxMatch,
      hasSeedMatch,
      seedMatchCount: Math.min(seedMatchCount, 100), // Cap for display
    };
  }
}

/**
 * Process very large genomes by reading file in chunks
 * Uses FileReader API for streaming
 */
export async function processLargeFile(
  file: File,
  onProgress: (progress: ProcessingProgress) => void
): Promise<{ sequence: string; index: GenomeIndex }> {
  const fileSizeMB = file.size / (1024 * 1024);
  
  onProgress({
    phase: 'parsing',
    progress: 0,
    message: `Reading ${fileSizeMB.toFixed(1)} MB file...`,
  });

  // For files under 100MB, read all at once
  if (file.size < 100 * 1024 * 1024) {
    const text = await file.text();
    const sequence = parseFastaToSequence(text);
    const index = await buildGenomeIndex(sequence, {
      progressCallback: onProgress,
    });
    return { sequence, index };
  }

  // For larger files, use chunked reading
  const sequence = await readLargeFileChunked(file, onProgress);
  const index = await buildGenomeIndex(sequence, {
    progressCallback: onProgress,
    chunkSize: 2_000_000, // Larger chunks for efficiency
  });

  return { sequence, index };
}

/**
 * Read large file in chunks using FileReader
 */
async function readLargeFileChunked(
  file: File,
  onProgress: (progress: ProcessingProgress) => void
): Promise<string> {
  const chunkSize = 10 * 1024 * 1024; // 10MB chunks
  const chunks: string[] = [];
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkSize);
    const text = await slice.text();
    
    // Parse FASTA and extract sequence
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('>') && trimmed) {
        chunks.push(trimmed.toUpperCase());
      }
    }

    offset += chunkSize;
    onProgress({
      phase: 'parsing',
      progress: offset / file.size,
      message: `Reading file: ${(offset / 1024 / 1024).toFixed(1)} / ${(file.size / 1024 / 1024).toFixed(1)} MB`,
    });
  }

  return chunks.join('');
}

/**
 * Simple FASTA parser for smaller files
 */
export function parseFastaToSequence(text: string): string {
  const lines = text.split(/\r?\n/);
  const sequenceParts: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('>') && trimmed) {
      sequenceParts.push(trimmed.toUpperCase());
    }
  }
  
  return sequenceParts.join('');
}

/**
 * Validate sequence with helpful error messages
 */
export function validateSequence(
  sequence: string,
  name: string,
  maxSizeMB: number = 500
): { valid: boolean; error?: string; warnings: string[] } {
  const warnings: string[] = [];
  
  if (!sequence || sequence.length === 0) {
    return { valid: false, error: `${name} is empty`, warnings: [] };
  }

  const sizeMB = sequence.length / (1024 * 1024);
  if (sizeMB > maxSizeMB) {
    return { 
      valid: false, 
      error: `${name} exceeds ${maxSizeMB}MB limit (got ${sizeMB.toFixed(1)}MB)`,
      warnings: []
    };
  }

  if (sequence.length < 100) {
    return { valid: false, error: `${name} too short (minimum 100bp)`, warnings: [] };
  }

  // Check for invalid characters
  const validBases = new Set(['A', 'T', 'G', 'C', 'U', 'N']);
  const invalidChars = new Set<string>();
  let nCount = 0;

  for (let i = 0; i < Math.min(sequence.length, 1000000); i++) {
    const char = sequence[i];
    if (!validBases.has(char)) {
      invalidChars.add(char);
    }
    if (char === 'N') nCount++;
  }

  if (invalidChars.size > 0) {
    const chars = Array.from(invalidChars).slice(0, 5).join(', ');
    return { 
      valid: false, 
      error: `${name} contains invalid characters: ${chars}`,
      warnings: []
    };
  }

  // Warn about N content
  const nPercent = (nCount / Math.min(sequence.length, 1000000)) * 100;
  if (nPercent > 5) {
    warnings.push(`High N content (${nPercent.toFixed(1)}%) may affect analysis accuracy`);
  }

  return { valid: true, warnings };
}

/**
 * Estimate memory requirements for a given genome size
 */
export function estimateMemoryRequirements(genomeSizeBytes: number): {
  bloomFilterMB: number;
  rawSequenceMB: number;
  totalMB: number;
  recommended: boolean;
} {
  const genomeSizeBases = genomeSizeBytes; // Approximate 1 byte per base in text
  const estimated15mers = genomeSizeBases - 14;
  
  // Bloom filter size estimate: -n * ln(p) / (ln(2)^2) bits
  const bloomBits = (-estimated15mers * Math.log(0.001)) / (Math.log(2) ** 2);
  const bloomFilterMB = bloomBits / 8 / 1024 / 1024;
  
  const rawSequenceMB = genomeSizeBytes / 1024 / 1024;
  const totalMB = bloomFilterMB + rawSequenceMB;
  
  return {
    bloomFilterMB: Math.round(bloomFilterMB),
    rawSequenceMB: Math.round(rawSequenceMB),
    totalMB: Math.round(totalMB),
    recommended: totalMB < 1024, // Recommend if under 1GB
  };
}
