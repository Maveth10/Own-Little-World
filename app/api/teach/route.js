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

// Precyzyjna funkcja wektoryzacji pokazująca dokładne błędy Hugging Face
async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error("Brak klucza HF_API_KEY w Vercelu. Sprawdź Environment Variables!");

  const url = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${apiKey}`, 
        "Content-Type": "application/json",
        "x-wait-for-model": "true" 
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
      cache: "no-store"
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json();
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
    if (Array.isArray(result) && typeof result[0] === 'number') return result;

    throw new Error(`Błędny format wektora z HF: ${JSON.stringify(result).slice(0, 100)}`);
  } catch (err) {
    throw new Error(`Błąd wektoryzacji HF: ${err.message}`);
  }
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

    // SEKWENCYJNA WEKTORYZACJA
    const records = [];
    for (const chunk of chunks) {
      if (!chunk.title || !chunk.content) continue;
      
      const embedding = await getEmbedding(`${chunk.title}: ${chunk.content}`);
      records.push({
        title: chunk.title,
        content: chunk.content,
        embedding,
        image_url: fileUrl
      });
      
      await new Promise((res) => setTimeout(res, 200));
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