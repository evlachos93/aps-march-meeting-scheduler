
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Filter talks or sessions from a JSON file by removing those that contain any of the provided keywords in the specified field.
 * 
 * Usage: npx ts-node filterByKeywords.ts <filePath> <field> "keyword1,keyword2,keyword3"
 * Fields for talks: topics, title, abstract
 * Fields for sessions: title, talkTitles, description
 */

const args = process.argv.slice(2);
if (args.length < 3) {
    console.error('Usage: npx ts-node filterByKeywords.ts <filePath> <field> "keyword1,keyword2,..."');
    console.error('Talk Fields: topics, title, abstract');
    console.error('Session Fields: title, talkTitles, description');
    process.exit(1);
}

const inputPath = join(process.cwd(), args[0]);
const filterField = args[1]; // Keep case for easier property mapping if needed, but we'll normalize
const keywords = args[2].split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0);
const outputPath = inputPath; // Overwrite the input file

if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}

function filterByKeywords() {
    console.log(`Filtering file: ${inputPath}`);
    console.log(`By keywords in ${filterField}: ${keywords.join(', ')}`);

    const data = JSON.parse(readFileSync(inputPath, 'utf8'));
    
    // Determine if we're dealing with talks or sessions
    // talks.json has { talks: [...] }
    // sessions.json has { sessions: [...] }
    let items = data.talks || data.sessions || (Array.isArray(data) ? data : null);

    if (!items || !Array.isArray(items)) {
        console.error('Data format not recognized. Expected { talks: [] }, { sessions: [] }, or an array.');
        process.exit(1);
    }

    console.log(`Initial count: ${items.length}`);

    const result = items.filter((item: any) => {
        let textToSearch = '';

        const field = filterField.toLowerCase();

        if (field === 'topics') {
            const topics = Array.isArray(item.topics) ? item.topics : [];
            textToSearch = topics.join(' ').toLowerCase();
        } else if (field === 'title') {
            textToSearch = (item.title || '').toLowerCase();
        } else if (field === 'abstract') {
            textToSearch = (item.abstract || '').toLowerCase();
        } else if (field === 'description') {
            textToSearch = (item.description || '').toLowerCase();
        } else if (field === 'talktitles') {
            // sessions.json uses talkTitles array
            const talkTitles = Array.isArray(item.talkTitles) ? item.talkTitles : [];
            textToSearch = talkTitles.join(' ').toLowerCase();
        } else {
            console.error(`Invalid field: ${filterField}. Use 'topics', 'title', 'abstract', 'talkTitles', or 'description'.`);
            process.exit(1);
        }

        // If ANY input keyword is found in the text, remove the item
        const found = keywords.some(keyword => textToSearch.includes(keyword));
        return !found;
    });

    console.log(`Remaining count: ${result.length} (${items.length - result.length} removed)`);

    // Reconstruction of the original object structure
    let outputData;
    if (data.talks) {
        outputData = { ...data, total: result.length, talks: result };
    } else if (data.sessions) {
        outputData = { ...data, sessions: result };
    } else {
        outputData = result;
    }

    writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`Results written to: ${outputPath}`);
}

filterByKeywords();
