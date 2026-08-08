import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';

export const maxDuration = 60;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

// Odporna funkcja wektoryzacji z podwójnym endpointem i próbami ponowienia
async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error("Brak klucza HF_API_KEY");

  const endpoints = [
    "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2",
    "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2"
  ];

  for (const url of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 
            Authorization: `Bearer ${apiKey}`, 
            "Content-Type": "application/json",
            "x-wait-for-model": "true" 
          },
          method: "POST",
          body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
        });

        if (response.ok) {
          const result = await response.json();
          if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
          if (Array.isArray(result)) return result;
        }
      } catch (err) {
        console.warn(`Próba połączenia z ${url} (próba ${attempt + 1}) nie powiodła się:`, err.message);
      }
    }
  }

  throw new Error("Błąd Hugging Face: Serwer wektoryzacji nie odpowiada po kilku próbach.");
}

export async function POST(req) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabase = getSupabase();

    const body = await req.json();
    const { title = '', content = '', fileUrl = null, fileName = '', fileType = '' } = body;
    const userInput = content || title || '';

    if (!userInput && !fileUrl) {
      return NextResponse.json({ success: false, error: "Brak materiału do analizy." }, { status: 400 });
    }

    const systemPromptJSON = `Jesteś inżynierem serwisu stacji EV. Przeanalizuj podany tekst techniczny/instrukcję.
Zwróć odpowiedź WYŁĄCZNIE jako tablicę obiektów JSON (bez formatowania markdown, sam surowy kod JSON):
[
  {
    "title": "Dokładny tytuł sekcji/schematu (np. AXON EASY 60 - Zestawienie połączeń)",
    "content": "Pełna, szczegółowa wiedza techniczna: opis połączeń, oznaczenia pinów, kabli, przekaźników i parametrów"
  }
]
Podziel skomplikowane tabele na czytelne fragmenty dla inżyniera.`;

    let chunks = [];
    const isPdf = fileUrl && (fileType === 'application/pdf' || fileName.endsWith('.pdf'));
    const isImage = fileUrl && fileType.startsWith('image/');

    // OBSŁUGA PDF (Pobranie z Supabase Storage i parsowanie tekstu)
    if (isPdf) {
      const pdfRes = await fetch(fileUrl);
      if (!pdfRes.ok) throw new Error("Nie udało się pobrać pliku PDF z magazynu Supabase.");
      const arrayBuffer = await pdfRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const pdfData = await pdfParse(buffer);
      const extractedPdfText = pdfData.text || "";

      const groqPrompt = `Przeanalizuj poniższą dokumentację techniczną z pliku PDF i ustrukturyzuj ją dla serwisanta.\nNotatka użytkownika: "${userInput}"\n\nTREŚĆ DOKUMENTACJI PDF:\n${extractedPdfText.slice(0, 30000)}`;

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPromptJSON },
          { role: 'user', content: groqPrompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
      });

      const responseText = chatCompletion.choices[0]?.message?.content || "[]";
      try {
        chunks = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
      } catch {
        chunks = [{ title: fileName || "Dokumentacja PDF", content: extractedPdfText.slice(0, 4000) }];
      }

    // OBSŁUGA ZDJĘĆ
    } else if (isImage) {
      const imgRes = await fetch(fileUrl);
      if (!imgRes.ok) throw new Error("Nie udało się pobrać pliku obrazu z magazynu Supabase.");
      const arrayBuffer = await imgRes.arrayBuffer();
      const base64Image = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = fileType || "image/jpeg";
      const orApiKey = process.env.OPENROUTER_API_KEY;

      const visionPrompt = "Przeanalizuj ten obraz ze szczegółami. Wypisz każdy tekst, oznaczenie komponentów, schematy połączeń i złącza.";

      const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${orApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://own-little-world.vercel.app",
          "X-Title": "Axon AI Serwis"
        },
        body: JSON.stringify({
          model: "nvidia/nemotron-nano-12b-v2-vl:free",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: visionPrompt },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
              ]
            }
          ]
        })
      });

      let visionDescription = "Brak opisu obrazu.";
      if (orResponse.ok) {
        const orData = await orResponse.json();
        visionDescription = orData.choices[0]?.message?.content || visionDescription;
      }

      const groqPrompt = `Notatki: "${userInput}"\n\nOpis obrazu:\n"${visionDescription}"\n\nPrzygotuj tablicę JSON.`;

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPromptJSON },
          { role: 'user', content: groqPrompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
      });

      const responseText = chatCompletion.choices[0]?.message?.content || "[]";
      try {
        chunks = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
      } catch {
        chunks = [{ title: fileName || "Wpis ze zdjęcia", content: visionDescription }];
      }

    // OBSŁUGA SAMEGO TEKSTU
    } else {
      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'system', content: systemPromptJSON }, { role: 'user', content: userInput }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
      });
      const responseText = chatCompletion.choices[0]?.message?.content || "[]";
      try {
        chunks = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
      } catch {
        chunks = [{ title: title || "Wpis własny", content: userInput }];
      }
    }

    if (!Array.isArray(chunks)) chunks = [chunks];

    // RÓWNOLEGŁA WEKTORYZACJA
    const recordPromises = chunks.map(async (chunk) => {
      if (!chunk.title || !chunk.content) return null;
      try {
        const embedding = await getEmbedding(`${chunk.title}: ${chunk.content}`);
        if (embedding) {
          return { title: chunk.title, content: chunk.content, embedding, image_url: fileUrl };
        }
      } catch (err) {
        console.error("Błąd wektoryzacji fragmentu:", err);
      }
      return null;
    });

    const records = (await Promise.all(recordPromises)).filter(Boolean);

    if (chunks.length > 0 && records.length === 0) {
      throw new Error("Usługa Hugging Face nie zgenerowała wektorów. Spróbuj ponownie za chwilę.");
    }

    if (records.length > 0) {
      const { error: dbError } = await supabase.from('memories').insert(records);
      if (dbError) throw dbError;
    }

    return NextResponse.json({
      success: true,
      message: `Przeanalizowano plik i dodano ${records.length} wpisów do bazy wiedzy!`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}