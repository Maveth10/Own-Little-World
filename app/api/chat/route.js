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

export async function POST(req) {
  try {
    const formData = await req.formData();
    const prompt = formData.get('prompt');
    const image = formData.get('image');

    // Wektoryzacja pytania lokalnie
    const queryVector = await getLocalEmbedding(prompt);

    let docs = [];
    if (queryVector) {
      const { data, error: rpcError } = await supabase.rpc('match_memory', {
        query_embedding: queryVector,
        match_threshold: 0.1,
        match_count: 2,
      });

      if (!rpcError && data) docs = data;
    }

    let contextText = '';
    let foundImageUrl = null;

    if (docs.length > 0) {
      contextText =
        '\n\nOto dokumentacja techniczna z bazy wiedzy serwisu (użyj jej do odpowiedzi):\n';
      docs.forEach((doc, index) => {
        contextText += `--- Dokument ${index + 1}: ${doc.title} ---\n${
          doc.content
        }\n`;
        if (doc.image_url && !foundImageUrl) {
          foundImageUrl = doc.image_url;
        }
      });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const systemInstruction =
      'Jesteś Głównym Inżynierem Serwisu. Odpowiadaj konkretnie i na temat. Jeśli baza wiedzy zawiera potrzebne informacje lub schemat, odnieś się do nich.';
    const fullPrompt = `${systemInstruction}${contextText}\n\nPytanie od serwisanta: ${prompt}`;

    let result;
    if (image && image !== 'null') {
      const buffer = Buffer.from(await image.arrayBuffer());
      const imageParts = [
        {
          inlineData: { data: buffer.toString('base64'), mimeType: image.type },
        },
      ];
      result = await model.generateContent([fullPrompt, ...imageParts]);
    } else {
      result = await model.generateContent(fullPrompt);
    }

    let responseText = result.response.text();

    if (foundImageUrl) {
      responseText += `\n\n**Oto powiązany schemat:**\n![Schemat](${foundImageUrl})`;
    }

    return NextResponse.json({ success: true, text: responseText });
  } catch (error) {
    console.error('Błąd Silnika AI:', error);
    return NextResponse.json(
      { success: false, error: 'Wystąpił problem z analizą AI.' },
      { status: 500 }
    );
  }
}
