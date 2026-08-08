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

// Generowanie wektorów w Hugging Face
async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error("Brak klucza HF_API_KEY");

  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "x-wait-for-model": "true" },
        method: "POST",
        body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
      }
    );

    if (!response.ok) throw new Error(`Błąd HTTP: ${response.status}`);
    const result = await response.json();
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
    if (Array.isArray(result)) return result;
    throw new Error("Nieprawidłowy format wektora");
  } catch (err) {
    throw new Error(`Błąd Hugging Face (Wektoryzacja): ${err.message}`);
  }
}

export async function POST(req) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabase = getSupabase();

    const formData = await req.formData();
    const userInput = formData.get('content') || formData.get('prompt') || formData.get('title') || '';
    const uploadedFile = formData.get('file');
    const hasFile = uploadedFile && typeof uploadedFile === 'object' && uploadedFile.size > 0;

    if (!userInput && !hasFile) {
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
    let extractedPdfText = "";
    const isPdf = hasFile && (uploadedFile.type === 'application/pdf' || uploadedFile.name.endsWith('.pdf'));
    const isImage = hasFile && uploadedFile.type && uploadedFile.type.startsWith('image/');

    // ---------------------------------------------------------
    // OBSŁUGA PLIKÓW PDF (Ekstrakcja cyfrowego tekstu z CAD/EPLAN)
    // ---------------------------------------------------------
    if (isPdf) {
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const pdfData = await pdfParse(buffer);
      extractedPdfText = pdfData.text;

      // Pytamy Groqa o przetworzenie tekstu z PDF na czysty JSON
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
        chunks = [{ title: uploadedFile.name, content: extractedPdfText.slice(0, 4000) }];
      }

    // ---------------------------------------------------------
    // OBSŁUGA ZDJĘĆ (Nvidia Vision przez OpenRouter)
    // ---------------------------------------------------------
    } else if (isImage) {
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const base64Image = buffer.toString("base64");
      const mimeType = uploadedFile.type || "image/jpeg";
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
        chunks = [{ title: "Wpis ze zdjęcia", content: visionDescription }];
      }

    // ---------------------------------------------------------
    // OBSŁUGA SAMESO TEKSTU / NOTATKI
    // ---------------------------------------------------------
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
        chunks = [{ title: "Wpis własny", content: userInput }];
      }
    }

    if (!Array.isArray(chunks)) chunks = [chunks];

    // Zapis ewentualnego pliku w Supabase Storage
    let fileUrl = null;
    if (hasFile) {
      const safeName = uploadedFile.name.replace(/[^a-zA-Z0-9.-]/g, '');
      const fileName = `${Date.now()}_${safeName}`;
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const { data: uploadData } = await supabase.storage.from('schematy').upload(fileName, buffer, { contentType: uploadedFile.type, upsert: true });
      if (uploadData) {
        fileUrl = supabase.storage.from('schematy').getPublicUrl(fileName).data.publicUrl;
      }
    }

    // Wektoryzacja w Hugging Face i zapis do bazy danych Supabase
    const records = [];
    for (const chunk of chunks) {
      if (!chunk.title || !chunk.content) continue;
      const embedding = await getEmbedding(`${chunk.title}: ${chunk.content}`);
      if (embedding) {
        records.push({ title: chunk.title, content: chunk.content, embedding, image_url: fileUrl });
      }
    }

    if (records.length > 0) {
      const { error: dbError } = await supabase.from('memories').insert(records);
      if (dbError) throw dbError;
    }

    return NextResponse.json({ success: true, message: `Sukces! Przeanalizowano plik i dodano ${records.length} kompletnych wpisów do bazy wiedzy!` });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}