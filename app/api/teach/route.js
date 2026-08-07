import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { pipeline } from '@xenova/transformers';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

let extractorPipeline = null;

async function getLocalEmbedding(text) {
  if (!extractorPipeline) {
    extractorPipeline = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );
  }
  const output = await extractorPipeline(text, {
    pooling: 'mean',
    normalize: true,
  });
  return Array.from(output.data);
}

function sanitizeFilename(name) {
  const map = {
    ą: 'a',
    ć: 'c',
    ę: 'e',
    ł: 'l',
    ń: 'n',
    ó: 'o',
    ś: 's',
    ź: 'z',
    ż: 'z',
    Ą: 'A',
    Ć: 'C',
    Ę: 'E',
    Ł: 'L',
    Ń: 'N',
    Ó: 'O',
    Ś: 'S',
    Ź: 'Z',
    Ż: 'Z',
  };
  let clean = name.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (match) => map[match]);
  return clean.replace(/[^a-zA-Z0-9.-]/g, '_').toLowerCase();
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    let title = formData.get('title');
    const content = formData.get('content') || '';
    const file = formData.get('file');

    let image_url = null;
    let autoExtractedKeywords = '';

    if (file && file !== 'null') {
      const cleanName = sanitizeFilename(file.name);
      const uniqueName = `${Date.now()}_${cleanName}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      const { error: uploadError } = await supabase.storage
        .from('schematics')
        .upload(uniqueName, buffer, { contentType: file.type, upsert: false });

      if (uploadError)
        throw new Error('Błąd wgrywania pliku: ' + uploadError.message);

      const { data: publicUrlData } = supabase.storage
        .from('schematics')
        .getPublicUrl(uniqueName);
      image_url = publicUrlData.publicUrl;

      try {
        const visionModel = genAI.getGenerativeModel({
          model: 'gemini-1.5-flash',
        });
        const fileParts = [
          {
            inlineData: {
              data: buffer.toString('base64'),
              mimeType: file.type,
            },
          },
        ];

        const extractionPrompt = `Jesteś inżynierem. Przeanalizuj ten dokument. Zwróć odpowiedź DOKŁADNIE w dwóch linijkach:
TYTUŁ: [wygeneruj krótki, techniczny tytuł (max 4 słowa)]
TAGI: [wypisz po przecinku słowa kluczowe, piny, złącza, ścieżki, opisy]`;

        const visionResult = await visionModel.generateContent([
          extractionPrompt,
          ...fileParts,
        ]);
        const visionText = visionResult.response.text();

        const lines = visionText.split('\n');
        lines.forEach((line) => {
          if (line.startsWith('TYTUŁ:') && !title)
            title = line.replace('TYTUŁ:', '').trim();
          if (line.startsWith('TAGI:'))
            autoExtractedKeywords = line.replace('TAGI:', '').trim();
        });
      } catch (visionError) {
        console.error('Błąd AI obrazu:', visionError);
      }

      if (!title)
        title = file.name
          .split('.')
          .slice(0, -1)
          .join('.')
          .replace(/[_.-]/g, ' ');
    }

    if (!title) title = 'Notatka serwisowa';

    const enrichedContent = autoExtractedKeywords
      ? `${content}\n\n[TAGI Z PLIKU]: ${autoExtractedKeywords}`
      : content;

    // Generowanie wektora lokalnie w aplikacji
    const embedding = await getLocalEmbedding(enrichedContent);

    const { error } = await supabase
      .from('ai_memory')
      .insert([{ title, content: enrichedContent, image_url, embedding }]);

    if (error) throw new Error('Błąd zapisu w Supabase: ' + error.message);

    return NextResponse.json({
      success: true,
      message: `Zapisano w pamięci! Tytuł: "${title}"`,
    });
  } catch (error) {
    console.error('Błąd uczenia:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Błąd zapisu' },
      { status: 500 }
    );
  }
}
