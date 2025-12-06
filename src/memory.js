import { VoyageAIClient } from 'voyageai';
import { loadData, saveData, formatDuration } from './storage.js';

// Initialize Voyage AI client (requires VOYAGE_API_KEY env var)
let voyageClient = null;

function getVoyageClient() {
    if (!voyageClient) {
        const apiKey = process.env.VOYAGE_API_KEY;
        if (!apiKey) {
            throw new Error('VOYAGE_API_KEY environment variable is required for memory features');
        }
        voyageClient = new VoyageAIClient({ apiKey });
    }
    return voyageClient;
}

/**
 * Generate embeddings for text
 * @param {string[]} texts - Array of texts to embed
 * @param {string} inputType - 'document' for storing, 'query' for searching
 * @returns {number[][]} Array of embeddings
 */
export async function getEmbeddings(texts, inputType = 'document') {
    const client = getVoyageClient();
    const response = await client.embed({
        input: texts,
        model: 'voyage-3-lite',
        inputType: inputType
    });
    return response.data.map(item => item.embedding);
}

/**
 * Rerank documents by relevance to query
 * @param {string} query - Search query
 * @param {string[]} documents - Documents to rerank
 * @param {number} topK - Number of top results to return
 * @returns {Object[]} Reranked documents with scores
 */
export async function rerankDocuments(query, documents, topK = 5) {
    const client = getVoyageClient();
    const response = await client.rerank({
        query: query,
        documents: documents,
        model: 'rerank-2-lite',
        topK: Math.min(topK, documents.length)
    });
    return response.data;
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Cosine similarity (-1 to 1)
 */
function cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Store a memory with its embedding
 * @param {string} content - Memory content
 * @param {Object} options - Optional settings
 * @returns {Object} The created memory
 */
export async function storeMemory(content, options = {}) {
    const data = loadData();

    // Initialize memories array if it doesn't exist
    if (!data.memories) {
        data.memories = [];
    }

    // Generate embedding
    const [embedding] = await getEmbeddings([content], 'document');

    const memory = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        content: content,
        category: options.category || '',
        shared: options.shared !== false, // Default to shared
        projectId: options.project ? options.project.toLowerCase().trim() : null,
        clientId: options.client ? options.client.toLowerCase().trim().replace(/\s+/g, '-') : null,
        user: process.env.CALQ_USER || 'unknown',
        embedding: embedding,
        createdAt: new Date().toISOString()
    };

    data.memories.push(memory);
    saveData(data);

    return memory;
}

/**
 * Search memories semantically
 * @param {string} query - Search query
 * @param {Object} options - Filter options
 * @returns {Object[]} Matching memories
 */
export async function searchMemories(query, options = {}) {
    const data = loadData();
    const currentUser = process.env.CALQ_USER || 'unknown';
    const limit = options.limit || 5;
    const useReranking = options.rerank !== false;

    if (!data.memories || data.memories.length === 0) {
        return [];
    }

    // Filter memories based on visibility and scope
    let filteredMemories = data.memories.filter(m => {
        // Check visibility: shared OR own personal memories
        if (!m.shared && m.user !== currentUser) return false;

        // Filter by project if specified
        if (options.project && m.projectId !== options.project.toLowerCase().trim()) return false;

        // Filter by client if specified
        if (options.client && m.clientId !== options.client.toLowerCase().trim().replace(/\s+/g, '-')) return false;

        return true;
    });

    if (filteredMemories.length === 0) {
        return [];
    }

    // Get query embedding
    const [queryEmbedding] = await getEmbeddings([query], 'query');

    // Calculate similarities
    const memoriesWithScores = filteredMemories.map(memory => ({
        ...memory,
        similarity: cosineSimilarity(queryEmbedding, memory.embedding)
    }));

    // Sort by similarity
    memoriesWithScores.sort((a, b) => b.similarity - a.similarity);

    // Take top candidates (more than limit for reranking)
    const candidates = memoriesWithScores.slice(0, useReranking ? limit * 2 : limit);

    if (useReranking && candidates.length > 1) {
        // Rerank for better precision
        const reranked = await rerankDocuments(
            query,
            candidates.map(m => m.content),
            limit
        );

        return reranked.map(r => ({
            ...candidates[r.index],
            relevanceScore: r.relevanceScore
        }));
    }

    return candidates.slice(0, limit);
}

/**
 * Search time entries semantically
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Object[]} Matching entries
 */
export async function searchEntries(query, limit = 10) {
    const data = loadData();

    if (!data.entries || data.entries.length === 0) {
        return [];
    }

    // Filter entries with descriptions
    const entriesWithText = data.entries.filter(e => e.description && e.description.trim());

    if (entriesWithText.length === 0) {
        return [];
    }

    // Use reranking directly (more efficient for this use case)
    const documents = entriesWithText.map(e =>
        `${e.description} (${data.projects[e.project]?.name || e.project})`
    );

    const reranked = await rerankDocuments(query, documents, limit);

    return reranked.map(r => ({
        ...entriesWithText[r.index],
        projectName: data.projects[entriesWithText[r.index].project]?.name || entriesWithText[r.index].project,
        relevanceScore: r.relevanceScore,
        durationFormatted: formatDuration(entriesWithText[r.index].minutes)
    }));
}

/**
 * Delete a memory by ID
 * @param {string} memoryId - Memory ID to delete
 * @returns {Object|null} Deleted memory or null
 */
export function deleteMemory(memoryId) {
    const data = loadData();

    if (!data.memories) {
        return null;
    }

    const index = data.memories.findIndex(m => m.id === memoryId);
    if (index === -1) return null;

    const deleted = data.memories.splice(index, 1)[0];
    saveData(data);

    return deleted;
}

/**
 * Get all memories (filtered by visibility)
 * @param {Object} options - Filter options
 * @returns {Object[]} Filtered memories
 */
export function getAllMemories(options = {}) {
    const data = loadData();
    const currentUser = process.env.CALQ_USER || 'unknown';

    let memories = (data.memories || []).filter(m => {
        // Check visibility
        if (!m.shared && m.user !== currentUser) return false;

        // Filter by category
        if (options.category && m.category?.toLowerCase() !== options.category.toLowerCase()) return false;

        // Filter by project
        if (options.project && m.projectId !== options.project.toLowerCase().trim()) return false;

        // Filter by client
        if (options.client && m.clientId !== options.client.toLowerCase().trim().replace(/\s+/g, '-')) return false;

        // Filter personal only
        if (options.personal && m.shared) return false;

        return true;
    });

    return memories.map(m => ({
        id: m.id,
        content: m.content,
        category: m.category,
        shared: m.shared,
        projectId: m.projectId,
        clientId: m.clientId,
        user: m.user,
        createdAt: m.createdAt
    }));
}
