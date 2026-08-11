import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; 
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Brak kluczy Supabase.");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. ZEROWANIE PAMIĘCI AI
    // Omija zmiany w schemacie (nowe kolumny) - po prostu "orze" całą tabelę do zera
    const { error: dbError } = await supabase
      .from('ai_memory')
      .delete()
      .neq('id', 0); // Bezpieczny hack na usunięcie wszystkich rekordów
      
    if (dbError) throw new Error(`Błąd czyszczenia pamięci: ${dbError.message}`);

    // 2. POBIERANIE LISTY PLIKÓW Z FOLDERU SCHEMATICS
    const { data: files, error: listError } = await supabase
      .storage
      .from('schematics')
      .list('', { limit: 1000 });
      
    if (listError) throw new Error(`Błąd pobierania listy plików: ${listError.message}`);

    // 3. FIZYCZNE USUWANIE PLIKÓW
    if (files && files.length > 0) {
      const fileNames = files.map(file => file.name);
      const { error: removeError } = await supabase
        .storage
        .from('schematics')
        .remove(fileNames);
        
      if (removeError) throw new Error(`Błąd usuwania plików: ${removeError.message}`);
    }

    return NextResponse.json({ success: true, message: "Baza wektorowa i folder schematów zostały zresetowane do zera." });
  } catch (error) {
    console.error("Błąd resetu:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}