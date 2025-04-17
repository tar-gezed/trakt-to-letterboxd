const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');

// --- Configuration ---
const watchedFilePath = path.join(__dirname, 'watched-movies.json');
const ratingsFilePath = path.join(__dirname, 'ratings-movies.json');
const outputCsvPath = path.join(__dirname, 'letterboxd_import.csv');
// --- End Configuration ---

// Helper function to read and parse JSON safely
function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(`Error: File not found at ${filePath}`);
            return null;
        }
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error) {
        console.error(`Error reading or parsing JSON file ${filePath}:`, error);
        return null;
    }
}

// Helper function to format date to YYYY-MM-DD
// Handles potential invalid date strings gracefully
function formatDate(dateString) {
    if (!dateString) return '';
    try {
        const date = new Date(dateString);
        // Check if the date is valid
        if (isNaN(date.getTime())) {
            console.warn(`Warning: Invalid date string encountered: ${dateString}. Skipping date.`);
            return '';
        }
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        console.warn(`Warning: Could not parse date string: ${dateString}. Error: ${e.message}. Skipping date.`);
        return '';
    }
}


// --- Main Processing Logic ---

async function processTraktData() {
    console.log('Reading Trakt data...');
    const watchedData = readJsonFile(watchedFilePath);
    const ratingsData = readJsonFile(ratingsFilePath);

    if (!watchedData || !ratingsData) {
        console.error('Failed to read one or both JSON files. Exiting.');
        return;
    }

    console.log(`Read ${watchedData.length} watched entries and ${ratingsData.length} rating entries.`);

    // Use a Map to store merged movie data, keyed by Trakt ID for efficient lookup
    const mergedMovies = new Map();

    // 1. Process Watched Movies
    console.log('Processing watched movies...');
    watchedData.forEach(item => {
        if (item.movie && item.movie.ids && item.movie.ids.trakt) {
            const traktId = item.movie.ids.trakt;
            const watchedDate = formatDate(item.last_watched_at);
            const movieInfo = {
                traktId: traktId,
                imdbID: item.movie.ids.imdb || '',
                tmdbID: item.movie.ids.tmdb || '',
                Title: item.movie.title || '',
                Year: item.movie.year || '',
                Rating10: '', // Initialize rating
                WatchedDate: watchedDate, // Use last watched date initially
                Rewatch: (item.plays || 0) > 1, // Set rewatch based on plays
                _lastWatchedTimestamp: item.last_watched_at // Store original timestamp for comparison
            };
            mergedMovies.set(traktId, movieInfo);
        } else {
            console.warn('Skipping watched item due to missing movie/ID data:', item);
        }
    });
    console.log(`Processed ${mergedMovies.size} unique movies from watched data.`);

    // 2. Process Rated Movies and Merge
    console.log('Processing rated movies and merging...');
    let ratingsMergedCount = 0;
    let ratingsAddedCount = 0;
    ratingsData.forEach(item => {
        if (item.type === 'movie' && item.movie && item.movie.ids && item.movie.ids.trakt) {
            const traktId = item.movie.ids.trakt;
            const rating = item.rating || ''; // Get rating (1-10)
            const ratedAtDate = formatDate(item.rated_at);
            const ratedAtTimestamp = item.rated_at;

            if (mergedMovies.has(traktId)) {
                // Movie exists from watched list, update it
                const existing = mergedMovies.get(traktId);
                existing.Rating10 = rating; // Add/Overwrite rating

                // Decide which date to keep: the latest one (most recent activity)
                const existingTimestamp = existing._lastWatchedTimestamp;
                if (ratedAtTimestamp && (!existingTimestamp || new Date(ratedAtTimestamp) > new Date(existingTimestamp))) {
                    existing.WatchedDate = ratedAtDate;
                    // Keep Rewatch flag from watched data if it exists
                } else if (!existing.WatchedDate && ratedAtDate) {
                    // If watched data didn't have a valid date, use the rating date
                    existing.WatchedDate = ratedAtDate;
                }
                 // If watched date is more recent or rating date is invalid, keep the watched date

                ratingsMergedCount++;
            } else {
                // Movie doesn't exist, add it from ratings data
                const movieInfo = {
                    traktId: traktId,
                    imdbID: item.movie.ids.imdb || '',
                    tmdbID: item.movie.ids.tmdb || '',
                    Title: item.movie.title || '',
                    Year: item.movie.year || '',
                    Rating10: rating,
                    WatchedDate: ratedAtDate, // Use rated date
                    Rewatch: false, // Not a rewatch if only rated
                    _lastWatchedTimestamp: null // No watched timestamp for comparison
                };
                mergedMovies.set(traktId, movieInfo);
                ratingsAddedCount++;
            }
        } else {
            console.warn('Skipping rating item as it is not a movie or missing data:', item);
        }
    });
    console.log(`Merged ratings for ${ratingsMergedCount} existing movies.`);
    console.log(`Added ${ratingsAddedCount} new movies from ratings data.`);
    console.log(`Total unique movies to write: ${mergedMovies.size}`);

    // 3. Prepare data for CSV Writer
    const records = Array.from(mergedMovies.values()).map(movie => ({
        // Prioritize IDs for matching as per Letterboxd recommendation
        imdbID: movie.imdbID,
        tmdbID: movie.tmdbID,
        Title: movie.Title,
        Year: movie.Year,
        Rating10: movie.Rating10,
        WatchedDate: movie.WatchedDate,
        Rewatch: movie.Rewatch ? 'Yes' : 'No', // Letterboxd expects Yes/No or true/false
    }));

    // 4. Write to CSV
    console.log(`Writing data to ${outputCsvPath}...`);
    const csvWriter = createObjectCsvWriter({
        path: outputCsvPath,
        header: [
            // Define headers in the desired order for the CSV
            { id: 'imdbID', title: 'imdbID' },
            { id: 'tmdbID', title: 'tmdbID' },
            { id: 'Title', title: 'Title' },
            { id: 'Year', title: 'Year' },
            { id: 'Rating10', title: 'Rating10' },
            { id: 'WatchedDate', title: 'WatchedDate' },
            { id: 'Rewatch', title: 'Rewatch' },
            // Add other optional Letterboxd columns here if needed (e.g., Tags, Review)
        ],
        // Let csv-writer handle quoting automatically
    });

    try {
        await csvWriter.writeRecords(records);
        console.log(`Successfully wrote ${records.length} records to ${outputCsvPath}`);
    } catch (error) {
        console.error('Error writing CSV file:', error);
    }
}

// Run the processing function
processTraktData();