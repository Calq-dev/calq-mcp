import { ChromaClient } from 'chromadb';
import { VoyageAIEmbeddingFunction } from '@chroma-core/voyageai';
import { saveMemory, getMemories, deleteMemoryFromDb, formatDuration } from './storage.js';

// Initialize ChromaDB client
let chromaClient = null;
let memoriesCollection = null;
let entriesCollection = null;
let voyageEmbedder = null;

async function getChromaClient() {
    if (!chromaClient) {
        const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
        chromaClient = new ChromaClient({ path: chromaUrl });
    }
    return chromaClient;
}

async function getVoyageEmbedder() {
    if (!voyageEmbedder) {
        const apiKey = process.env.VOYAGE_API_KEY;
        if (!apiKey) {
            throw new Error('VOYAGE_API_KEY environment variable is required for memory features');
        }
        voyageEmbedder = new VoyageAIEmbeddingFunction({
            apiKey: apiKey,
            model: 'voyage-3-lite'
        });
    }
    return voyageEmbedder;
}

async function getMemoriesCollection() {
    if (!memoriesCollection) {
        const client = await getChromaClient();
        const embedder = await getVoyageEmbedder();
        memoriesCollection = await client.getOrCreateCollection({
            name: 'calq_memories',
            embeddingFunction: embedder,
            metadata: { "hnsw:space": "cosine" }
        });
    }
    return memoriesCollection;
}

async function getEntriesCollection() {
    if (!entriesCollection) {
        const client = await getChromaClient();
        const embedder = await getVoyageEmbedder();
        entriesCollection = await client.getOrCreateCollection({
            name: 'calq_entries',
            embeddingFunction: embedder,
            metadata: { "hnsw:space": "cosine" }
        });
    }
    return entriesCollection;
}

/**
 * Store a memory in ChromaDB and PostgreSQL
 * @param {string} content - Memory content
 * @param {Object} options - Optional settings
 * @returns {Object} The created memory
 */
export async function storeMemory(content, options = {}) {
    const collection = await getMemoriesCollection();
    const currentUser = process.env.CALQ_USER || 'unknown';

    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const metadata = {
        category: options.category || '',
        shared: options.shared !== false,
        projectId: options.project ? options.project.toLowerCase().trim() : '',
        clientId: options.client ? options.client.toLowerCase().trim().replace(/\s+/g, '-') : '',
        user: currentUser,
        createdAt: new Date().toISOString()
    };

    // Store in ChromaDB
    try {
        await collection.add({
            ids: [id],
            documents: [content],
            metadatas: [metadata]
        });
    } catch (error) {
        console.error('ChromaDB store error:', error.message);
        // Continue to save in DB even if vector store fails
    }

    // Store in PostgreSQL
    return await saveMemory(id, content, metadata);
}

/**
 * Search memories semantically using ChromaDB
 * @param {string} query - Search query
 * @param {Object} options - Filter options
 * @returns {Object[]} Matching memories
 */
export async function searchMemories(query, options = {}) {
    const collection = await getMemoriesCollection();
    const currentUser = process.env.CALQ_USER || 'unknown';
    const limit = options.limit || 5;

    // Build where filter
    const whereConditions = [];

    // Only show shared memories or own personal memories
    whereConditions.push({
        '$or': [
            { shared: true },
            { user: currentUser }
        ]
    });

    if (options.project) {
        whereConditions.push({ projectId: options.project.toLowerCase().trim() });
    }

    if (options.client) {
        whereConditions.push({ clientId: options.client.toLowerCase().trim().replace(/\s+/g, '-') });
    }

    const whereFilter = whereConditions.length > 1
        ? { '$and': whereConditions }
        : whereConditions[0] || {};

    try {
        const results = await collection.query({
            queryTexts: [query],
            nResults: limit,
            where: Object.keys(whereFilter).length > 0 ? whereFilter : undefined
        });

        if (!results.documents || !results.documents[0]) {
            return [];
        }

        return results.documents[0].map((doc, i) => ({
            id: results.ids[0][i],
            content: doc,
            ...results.metadatas[0][i],
            distance: results.distances ? results.distances[0][i] : null,
            relevanceScore: results.distances ? 1 - results.distances[0][i] : null
        }));
    } catch (error) {
        console.error('ChromaDB search error:', error.message);
        // Fallback to PostgreSQL search
        return await fallbackSearchMemories(query, options);
    }
}

/**
 * Fallback search using PostgreSQL LIKE
 */
async function fallbackSearchMemories(query, options = {}) {
    const memories = await getAllMemories(options);
    const queryLower = query.toLowerCase();

    return memories
        .filter(m => m.content.toLowerCase().includes(queryLower))
        .slice(0, options.limit || 5)
        .map(m => ({ ...m, relevanceScore: null }));
}

/**
 * Index a time entry in ChromaDB for semantic search
 * @param {Object} entry - Entry object from storage
 * @returns {boolean} Success status
 */
export async function indexEntry(entry) {
    if (!entry.description) return false;

    try {
        const collection = await getEntriesCollection();
        const document = `${entry.project}: ${entry.description}`;

        await collection.add({
            ids: [entry.id],
            documents: [document],
            metadatas: [{
                projectId: entry.project,
                minutes: entry.minutes,
                type: entry.type || 'commit',
                billable: entry.billable,
                userId: entry.userId || '',
                createdAt: entry.createdAt
            }]
        });
        return true;
    } catch (error) {
        console.error('ChromaDB index entry error:', error.message);
        return false;
    }
}

/**
 * Remove an entry from ChromaDB
 * @param {string} entryId - Entry ID to remove
 */
export async function deleteEntryFromChroma(entryId) {
    try {
        const collection = await getEntriesCollection();
        await collection.delete({ ids: [entryId] });
    } catch (error) {
        console.error('ChromaDB delete entry error:', error.message);
    }
}

/**
 * Search time entries semantically using ChromaDB
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Object[]} Matching entries
 */
export async function searchEntries(query, limit = 10) {
    try {
        const collection = await getEntriesCollection();

        const results = await collection.query({
            queryTexts: [query],
            nResults: limit
        });

        if (!results.documents || !results.documents[0]) {
            return [];
        }

        return results.documents[0].map((doc, i) => ({
            id: results.ids[0][i],
            description: doc,
            projectName: results.metadatas[0][i].projectId,
            minutes: results.metadatas[0][i].minutes,
            durationFormatted: formatDuration(results.metadatas[0][i].minutes),
            type: results.metadatas[0][i].type,
            billable: results.metadatas[0][i].billable,
            createdAt: results.metadatas[0][i].createdAt,
            distance: results.distances ? results.distances[0][i] : null,
            relevanceScore: results.distances ? 1 - results.distances[0][i] : null
        }));
    } catch (error) {
        console.error('ChromaDB search entries error:', error.message);
        return [];
    }
}

/**
 * Delete a memory by ID
 * @param {string} memoryId - Memory ID to delete
 * @returns {Object|null} Deleted memory or null
 */
export async function deleteMemory(memoryId) {
    // Delete from PostgreSQL
    const deleted = await deleteMemoryFromDb(memoryId);

    if (deleted) {
        // Also delete from ChromaDB
        try {
            const collection = await getMemoriesCollection();
            await collection.delete({ ids: [memoryId] });
        } catch (error) {
            console.error('ChromaDB delete error:', error.message);
        }
    }

    return deleted;
}

/**
 * Get all memories (filtered by visibility)
 * @param {Object} options - Filter options
 * @returns {Object[]} Filtered memories
 */
export async function getAllMemories(options = {}) {
    return await getMemories(options);
}
