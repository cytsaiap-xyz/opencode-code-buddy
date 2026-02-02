/**
 * Simple Text Search Utility
 * 
 * Provides simple text search functionality, fully offline.
 * Supports keyword matching and fuzzy search.
 */

export interface SearchResult<T> {
    item: T;
    score: number;
    matches: string[];
}

export interface SearchOptions {
    /** Whether case sensitive */
    caseSensitive?: boolean;
    /** Minimum match score (0-1) */
    minScore?: number;
    /** Maximum result count */
    limit?: number;
}

/**
 * Simple text search engine
 */
export class SimpleSearch<T> {
    private items: T[] = [];
    private getSearchableText: (item: T) => string;

    constructor(getSearchableText: (item: T) => string) {
        this.getSearchableText = getSearchableText;
    }

    /**
     * Set search data
     */
    setItems(items: T[]): void {
        this.items = items;
    }

    /**
     * Add item
     */
    addItem(item: T): void {
        this.items.push(item);
    }

    /**
     * Search
     */
    search(query: string, options: SearchOptions = {}): SearchResult<T>[] {
        const {
            caseSensitive = false,
            minScore = 0.1,
            limit = 10
        } = options;

        const normalizedQuery = caseSensitive ? query : query.toLowerCase();
        const queryTerms = this.tokenize(normalizedQuery);

        const results: SearchResult<T>[] = [];

        for (const item of this.items) {
            const text = this.getSearchableText(item);
            const normalizedText = caseSensitive ? text : text.toLowerCase();

            const { score, matches } = this.calculateScore(normalizedText, queryTerms);

            if (score >= minScore) {
                results.push({ item, score, matches });
            }
        }

        // Sort by score
        results.sort((a, b) => b.score - a.score);

        // Limit results
        return results.slice(0, limit);
    }

    /**
     * Tokenize text
     */
    private tokenize(text: string): string[] {
        // Support Chinese and English tokenization
        return text
            .split(/[\s,，。、；;：:\-_!！?？]+/)
            .filter(term => term.length > 0);
    }

    /**
     * Calculate match score
     */
    private calculateScore(
        text: string,
        queryTerms: string[]
    ): { score: number; matches: string[] } {
        if (queryTerms.length === 0) {
            return { score: 0, matches: [] };
        }

        const matches: string[] = [];
        let matchCount = 0;

        for (const term of queryTerms) {
            if (text.includes(term)) {
                matchCount++;
                matches.push(term);
            } else {
                // Fuzzy match: check for similar words
                const fuzzyMatch = this.fuzzyMatch(text, term);
                if (fuzzyMatch) {
                    matchCount += 0.5;
                    matches.push(`~${term}`);
                }
            }
        }

        const score = matchCount / queryTerms.length;
        return { score, matches };
    }

    /**
     * Simple fuzzy matching
     */
    private fuzzyMatch(text: string, term: string): boolean {
        if (term.length < 2) return false;

        // Check if contains prefix or suffix of term
        const prefixLength = Math.ceil(term.length * 0.7);
        const prefix = term.substring(0, prefixLength);

        return text.includes(prefix);
    }
}

/**
 * Calculate similarity between two strings (Levenshtein distance based)
 */
export function stringSimilarity(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;

    if (len1 === 0) return len2 === 0 ? 1 : 0;
    if (len2 === 0) return 0;

    // Use simplified similarity calculation
    const maxLen = Math.max(len1, len2);
    let matches = 0;

    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    // Calculate common characters
    const charSet = new Set(s1);
    for (const char of s2) {
        if (charSet.has(char)) {
            matches++;
            charSet.delete(char);
        }
    }

    return matches / maxLen;
}

/**
 * Highlight matching text
 */
export function highlightMatches(text: string, terms: string[]): string {
    let result = text;

    for (const term of terms) {
        const cleanTerm = term.startsWith('~') ? term.substring(1) : term;
        const regex = new RegExp(`(${escapeRegex(cleanTerm)})`, 'gi');
        result = result.replace(regex, '**$1**');
    }

    return result;
}

/**
 * Escape regex special characters
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
