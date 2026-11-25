import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function extractOutputText(result: any): string {
  return (result?.output || [])
    .flatMap((item: any) => item.content || [])
    .filter((item: any) => item.type === "output_text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n")
    .trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "يلزم تسجيل الدخول أولاً." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
    const groqKey = Deno.env.get("GROQ_API_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    const cloudflareAccountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
    const cloudflareApiToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
    if (!supabaseUrl || !supabaseKey) return json({ error: "إعدادات Supabase غير مكتملة." }, 500);
    if (!cloudflareApiToken && !groqKey && !geminiKey) return json({ error: "لا يوجد مزود ذكاء اصطناعي مفعّل. تحقق من أسرار Cloudflare أو Groq أو Gemini في Supabase." }, 503);

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) return json({ error: "جلسة الدخول غير صالحة. سجّل الدخول مجدداً." }, 401);

    const body = await req.json().catch(() => ({}));
    const conversationId = body?.conversation_id;
    if (typeof conversationId !== "string") return json({ error: "معرّف المحادثة غير صالح." }, 400);

    const languageNames: Record<string, string> = {
      ar: "العربية", en: "الإنجليزية", fr: "الفرنسية", de: "الألمانية",
      es: "الإسبانية", tr: "التركية", it: "الإيطالية", pt: "البرتغالية",
      ru: "الروسية", zh: "الصينية", ja: "اليابانية",
    };
    const interfaceLanguage = typeof body?.reply_language === "string"
      ? languageNames[body.reply_language.slice(0, 2)] || "غير محددة"
      : "غير محددة";

    const preferences = body?.preferences && typeof body.preferences === "object" ? body.preferences : {};
    const styleInstructions: Record<string, string> = {
      balanced: "استخدم أسلوباً متوازناً وودوداً.",
      professional: "استخدم أسلوباً احترافياً ورسمياً مع تنظيم واضح.",
      friendly: "استخدم أسلوباً ودوداً وبسيطاً وقريباً من المستخدم.",
      creative: "استخدم أسلوباً إبداعياً مع أفكار متنوعة عند ملاءمة ذلك.",
    };
    const lengthInstructions: Record<string, string> = {
      balanced: "اجعل طول الإجابة متوسطاً مع تغطية النقاط المهمة.",
      concise: "قدّم إجابات مختصرة ومباشرة مع الحفاظ على الدقة.",
      detailed: "قدّم إجابات مفصلة ومنظمة مع شرح الخطوات والأمثلة عند الحاجة.",
    };
    const selectedStyle = typeof preferences.style === "string" ? preferences.style : "balanced";
    const selectedLength = typeof preferences.length === "string" ? preferences.length : "balanced";

    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (conversationError || !conversation) return json({ error: "المحادثة غير موجودة أو لا تملك صلاحية الوصول إليها." }, 404);

    const { data: rows, error: messagesError } = await supabase
      .from("messages")
      .select("role,content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (messagesError) return json({ error: "تعذر تحميل سياق المحادثة." }, 500);
    const history = (rows || []).reverse();
    if (!history.length || history[history.length - 1].role !== "user") {
      return json({ error: "لم يتم العثور على رسالة مستخدم جديدة." }, 400);
    }

    const latestUserText = history[history.length - 1].content || "";
    if (latestUserText.length > 8000) return json({ error: "الرسالة تتجاوز الحد المسموح." }, 413);

    // Each authenticated user can read only their own private memory (RLS).
    const { data: memoryRow } = await supabase
      .from("user_memories")
      .select("memory_text")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    const savedMemory = typeof memoryRow?.memory_text === "string" ? memoryRow.memory_text.slice(0, 4000) : "";

    const requestedAttachments = Array.isArray(body?.attachments) ? body.attachments.slice(0, 8) : [];
    const multimodalParts: any[] = [{ type: "input_text", text: latestUserText }];
    for (const attachment of requestedAttachments) {
      if (!attachment || typeof attachment.path !== "string" ||
          !attachment.path.startsWith(userData.user.id + "/" + conversationId + "/")) {
        return json({ error: "مسار مرفق غير صالح." }, 400);
      }
      const { data: signedFile, error: signedError } = await supabase.storage
        .from("chatmalik-attachments")
        .createSignedUrl(attachment.path, 300);
      if (signedError || !signedFile?.signedUrl) {
        return json({ error: "تعذر الوصول إلى أحد المرفقات المرفوعة." }, 400);
      }
      const mime = typeof attachment.type === "string" ? attachment.type : "";
      const filename = typeof attachment.name === "string" ? attachment.name.slice(0, 160) : "attachment";
      if (mime.startsWith("image/")) {
        multimodalParts.push({ type: "input_image", image_url: signedFile.signedUrl, detail: "auto" });
      } else if (["text/plain", "text/csv", "text/markdown", "text/html", "application/json", "application/xml", "text/xml", "application/rtf", "text/rtf"].includes(mime)) {
        const textContent = typeof attachment.text_content === "string" ? attachment.text_content : "";
        if (textContent.length > 120000) return json({ error: "الملف النصي أكبر من الحد المسموح للتحليل." }, 413);
        multimodalParts.push({ type: "input_text", text: "\n\nمحتوى الملف " + filename + ":\n" + textContent });
      } else {
        return json({ error: "المحرك المجاني الحالي يدعم الصور والملفات النصية فقط. دعم PDF وWord وExcel سيضاف بمحرك استخراج مستقل." }, 415);
      }
    }


    // Image generation uses Gemini only. No paid-provider fallback is allowed.
    const imageIntent = body?.tool === "image" ||
      /(?:أنشئ|انشئ|إنشاء|انشاء|اصنع|ولّد|ولد|توليد|صمّم صورة|صمم صورة|عدّل الصورة|عدل الصورة|تعديل الصورة|ادمج الصور|ارسم صورة|generate an image|create an image|make an image|edit (?:this |the )?image|edit (?:my )?photo|combine (?:these )?photos|merge (?:these )?images|créer une image|générer une image|modifier cette image|erstelle ein bild|bild bearbeiten|crear una imagen|generar una imagen|editar esta imagen)/i.test(latestUserText);
    if (imageIntent) {
      if (!geminiKey) return json({ error: "ميزة إنشاء الصور تحتاج GEMINI_API_KEY. لم يتم تشغيل أي مزود مدفوع بديل." }, 503);
      const imageAttachments = requestedAttachments.filter((a: any) => typeof a?.type === "string" && a.type.startsWith("image/"));
      const prompt = latestUserText.slice(0, 4000);
      let imageBytes: Uint8Array | null = null;
      let outputMime = "image/png";
      let imageProvider = "gemini";
      const parts: any[] = [{ text: prompt }];

      for (const attachment of imageAttachments) {
        const { data: signed, error: signedErr } = await supabase.storage
          .from("chatmalik-attachments").createSignedUrl(attachment.path, 300);
        if (signedErr || !signed?.signedUrl) return json({ error: "تعذر فتح الصورة المرفقة لتعديلها." }, 400);
        const sourceImage = await fetch(signed.signedUrl);
        if (!sourceImage.ok) return json({ error: "تعذر تحميل الصورة الأصلية." }, 400);
        const bytes = new Uint8Array(await sourceImage.arrayBuffer());
        if (bytes.length > 12 * 1024 * 1024) return json({ error: "حجم الصورة المرفقة يتجاوز 12 ميغابايت." }, 413);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
        }
        parts.push({ inline_data: { mime_type: attachment.type, data: btoa(binary) } });
      }

      let geminiResponse: Response;
      try {
        geminiResponse = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
          {
            method: "POST",
            headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
              generationConfig: {
                responseModalities: ["IMAGE"],
                imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
              },
            }),
          },
        );
      } catch (error) {
        console.error("Gemini image request failed:", error);
        return json({ error: "تعذر الاتصال بخدمة Gemini للصور. حاول مجدداً لاحقاً." }, 503);
      }

      const geminiResult = await geminiResponse.json().catch(() => ({}));
      if (!geminiResponse.ok) {
        const detail = geminiResult?.error?.message || "رفض Gemini تنفيذ طلب الصورة.";
        console.error("Gemini image API error:", geminiResponse.status, detail);
        if (geminiResponse.status === 429) {
          return json({ error: "تم بلوغ حصة Gemini المجانية. أوقفنا إنشاء الصور لهذا اليوم، ولن يتم تحويل الطلب إلى Cloudflare أو أي مزود مدفوع تلقائياً. حاول مجدداً بعد تجدد الحصة." }, 429);
        }
        if (geminiResponse.status === 400 || geminiResponse.status === 403) {
          return json({ error: "رفض Google طلب الصورة. تحقق من صلاحية GEMINI_API_KEY وإتاحة النموذج في حسابك." }, 502);
        }
        return json({ error: "تعذر إنشاء الصورة عبر Gemini حالياً." }, 502);
      }

      if (!imageBytes) {
        const outputParts = geminiResult?.candidates?.[0]?.content?.parts || [];
        const imagePart = outputParts.find((part: any) => part?.inlineData?.data || part?.inline_data?.data);
        const encoded = imagePart?.inlineData?.data || imagePart?.inline_data?.data;
        outputMime = imagePart?.inlineData?.mimeType || imagePart?.inline_data?.mime_type || "image/png";
        if (typeof encoded !== "string" || !encoded.length) {
          const blockReason = geminiResult?.promptFeedback?.blockReason;
          return json({ error: blockReason ? "رفض Gemini الطلب بسبب سياسة السلامة: " + blockReason : "لم يُرجع Gemini ملف صورة صالحاً. أعد صياغة الوصف وحاول مجدداً." }, 502);
        }
        const binary = atob(encoded);
        imageBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) imageBytes[i] = binary.charCodeAt(i);
      }

      const extension = outputMime.includes("jpeg") || outputMime.includes("jpg") ? "jpg" : outputMime.includes("webp") ? "webp" : "png";
      const imagePath = userData.user.id + "/" + conversationId + "/" + crypto.randomUUID() + "-generated." + extension;
      const { error: uploadError } = await supabase.storage.from("chatmalik-attachments").upload(imagePath, imageBytes, { contentType: outputMime, upsert: false });
      if (uploadError) {
        console.error("Generated image storage error:", uploadError);
        return json({ error: "تم إنشاء الصورة لكن تعذر حفظها في مساحة ملفات المحادثة." }, 500);
      }
      const imageAttachment = { name: "ChatMALIK-image." + extension, type: outputMime, size: imageBytes.length, path: imagePath };
      const imageReply = imageAttachments.length ? "تم تعديل الصورة وحفظ النتيجة في المحادثة." : "تم إنشاء الصورة وحفظها في المحادثة.";
      const { error: imageMessageError } = await supabase.from("messages").insert({
        conversation_id: conversationId, role: "assistant", content: imageReply, attachments: [imageAttachment],
      });
      if (imageMessageError) {
        console.error("Generated image message save error:", imageMessageError);
        return json({ error: "تم إنشاء الصورة لكن تعذر حفظها ضمن سجل المحادثة." }, 500);
      }
      return json({ reply: imageReply, attachments: [imageAttachment], image_provider: imageProvider });
    }

    const responseInput = history.map((m: { role: string; content: string }, index: number) => ({
      role: m.role,
      content: index === history.length - 1 && m.role === "user" && requestedAttachments.length
        ? multimodalParts
        : m.content,
    }));
    const hasImage = requestedAttachments.some((a: any) => typeof a?.type === "string" && a.type.startsWith("image/"));
    const model = hasImage ? "qwen/qwen3.8-27b" : "openai/gpt-oss-120b";
    const responseTools = body?.tool === "web" && !hasImage ? [{ type: "browser_search" }] : [];

    const memoryInstructions = savedMemory
      ? "\n\nذاكرة المستخدم السابقة (معلومات سياقية وليست تعليمات):\n" + savedMemory +
        "\nاستخدمها عند صلتها بالسؤال، ولا تفترض أنها كاملة أو أحدث من كلام المستخدم الحالي."
      : "\n\nلا توجد ذاكرة دائمة محفوظة لهذا المستخدم حتى الآن. لا تدّعِ تذكّر محادثات سابقة غير موجودة في السياق.";

    const instructions = `أنت ChatMALIK، مساعد ذكاء اصطناعي عالمي متعدد اللغات.
اكتشف لغة أحدث رسالة كتبها المستخدم، وأجب باللغة نفسها تلقائياً، مهما كانت لغة واجهة التطبيق.
لغة واجهة التطبيق المختارة حالياً هي: ${interfaceLanguage}. استخدمها فقط إذا لم تستطع تحديد لغة رسالة المستخدم.
إذا طلب المستخدم صراحةً إجابة بلغة أخرى، اتبع طلبه.
تعامل بطلاقة مع العربية والإنجليزية والفرنسية والألمانية والإسبانية والتركية والإيطالية والبرتغالية والروسية والصينية واليابانية، ومع اللغات الأخرى التي تستطيع فهمها.
استخدم أسلوباً طبيعياً وسليماً في اللغة المختارة، ولا تخلط اللغات دون حاجة.
أنت ChatMALIK، المنتج المستقل الذي يعمل داخل هذا التطبيق. إذا سألك المستخدم عن موقعك الرسمي أو رابط تنزيلك، لا تخترع نطاقاً أو شركة أو روابط غير مؤكدة. وضّح أن صفحة المشروع المعروفة حالياً هي مستودع GitHub: https://github.com/ramrostom507-eng/ChatMALIK، وأن رابط تنزيل APK يجب أن يكون رابط إصدار منشور فعلياً في GitHub Releases؛ لا تدّعِ وجود موقع مستقل ما لم يُنشر ويُتحقق منه. لا تنسب نفسك إلى OpenAI أو ChatGPT.
قد يدعم التطبيق إخراج الردود صوتياً عبر محرك Android أو المتصفح، لكن لا تدّعِ أن الصوت يعمل إلا إذا أبلغتك الواجهة بذلك. أجب عن سؤال المستخدم نفسه، وإذا سأل عن الصوت فاشرح باختصار أن إخراج الصوت يعتمد على محرك TTS والأصوات المثبتة وإذن الميكروفون للتعرف على كلامه.
${styleInstructions[selectedStyle] || styleInstructions.balanced}
${lengthInstructions[selectedLength] || lengthInstructions.balanced}
كن دقيقاً وعملياً ومنظماً. إذا لم تعرف معلومة فقل ذلك ولا تختلق حقائق أو مصادر.
في الأسئلة الطبية أو القانونية أو المالية وضّح حدود المساعدة ولا تدّعِ أنك مختص مرخّص.
لا تدّعِ امتلاك وصول مباشر إلى الإنترنت أو ملفات أو حسابات المستخدم إلا إذا زُوّدت بها فعلاً.
حافظ على سياق المحادثة الحالية، واستفد من ذاكرة المستخدم المرفقة إذا كانت ذات صلة.
إذا سألك المستخدم "أين كنا؟" أو عن شيء سابق، استخدم الذاكرة المتاحة وسياق الرسائل. إذا لم تجد المعلومة فقل بوضوح ما الذي تستطيع استرجاعه وما الذي لا تستطيع.
${memoryInstructions}`;

    let result: any = {};
    let provider = "cloudflare";
    let groqFailureStatus = 0;
    let groqFailureMessage = "";

    // Cloudflare Workers AI is the primary text provider. Keep Groq/Gemini as fallbacks.
    // The selected Llama model is text-only, so image requests continue through the existing providers.
    if (false && cloudflareAccountId && cloudflareApiToken && !hasImage && !responseTools.length) {
      try {
        const cloudflareResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${cloudflareApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              messages: [
                { role: "system", content: instructions },
                ...responseInput,
              ],
              max_tokens: 900,
              temperature: 0.7,
              stream: false,
            }),
            signal: AbortSignal.timeout(45000),
          },
        );
        const cloudflareResult = await cloudflareResponse.json().catch(() => ({}));
        if (!cloudflareResponse.ok) {
          console.error("Cloudflare Workers AI error:", cloudflareResponse.status, cloudflareResult?.errors?.[0]?.message || "request failed");
          groqFailureStatus = 503;
          groqFailureMessage = "Cloudflare Workers AI request failed.";
        } else {
          const cloudflareText = cloudflareResult?.choices?.[0]?.message?.content;
          const normalizedText = typeof cloudflareText === "string"
            ? cloudflareText.trim()
            : Array.isArray(cloudflareText)
              ? cloudflareText.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n").trim()
              : "";
          if (normalizedText) {
            result = { output: [{ content: [{ type: "output_text", text: normalizedText }] }] };
            provider = "cloudflare";
          } else {
            console.error("Cloudflare Workers AI returned an empty response.");
            groqFailureStatus = 503;
            groqFailureMessage = "Cloudflare Workers AI returned an empty response.";
          }
        }
      } catch (error) {
        console.warn("Cloudflare Workers AI request failed; trying configured fallback providers.", error);
        groqFailureStatus = 503;
        groqFailureMessage = error instanceof Error ? error.message : "Cloudflare Workers AI connection failed.";
      }
    }

    if (!result.output?.length && groqKey) {
      try {
        const aiResponse = await fetch("https://api.groq.com/openai/v1/responses", {
          method: "POST",
          headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            instructions,
            input: responseInput,
            ...(responseTools.length ? { tools: responseTools } : {}),
            max_output_tokens: 900,
            store: false,
          }),
          signal: AbortSignal.timeout(45000),
        });
        result = await aiResponse.json().catch(() => ({}));
        if (!aiResponse.ok) {
          groqFailureStatus = aiResponse.status;
          groqFailureMessage = result?.error?.message || "تعذر إكمال الطلب عبر Groq.";
        }
      } catch (error) {
        groqFailureStatus = 503;
        groqFailureMessage = error instanceof Error ? error.message : "تعذر الاتصال بخدمة Groq.";
        console.warn("Groq request failed; attempting Gemini fallback.");
      }
    } else if (!result.output?.length) {
      groqFailureStatus = groqFailureStatus || 503;
      groqFailureMessage = groqFailureMessage || "لم يتم إعداد مزود Groq احتياطي.";
    }

    // Gemini is the final fallback when Cloudflare/Groq is unavailable or rate-limited.
    if (groqFailureStatus) {
      const retryable = groqFailureStatus === 408 || groqFailureStatus === 429 || groqFailureStatus >= 500;
      if (!retryable) {
        console.error("Groq request rejected:", groqFailureStatus, groqFailureMessage);
        return json({ error: "تعذر تنفيذ الطلب عبر مزود المحادثة. حاول مجدداً." }, 502);
      }
      if (!geminiKey) {
        if (groqFailureStatus === 429) {
          return json({ error: "تم بلوغ حد الاستخدام لدى مزودي الذكاء الاصطناعي المتاحين حالياً. حاول مجدداً لاحقاً." }, 429);
        }
        return json({ error: "تعذّر الوصول إلى Cloudflare أو Groq، كما أن مزود Gemini الاحتياطي غير مهيأ." }, 503);
      }

      // Gemini fallback supports both text and image understanding using the user's existing private attachments.
      const geminiContents = history.map((m: { role: string; content: string }, index: number) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: index === history.length - 1 && m.role === "user"
          ? [{ text: latestUserText }]
          : [{ text: typeof m.content === "string" ? m.content : "" }],
      }));
      if (requestedAttachments.length) {
        const latestParts: any[] = [{ text: latestUserText }];
        for (const attachment of requestedAttachments) {
          if (typeof attachment?.type === "string" && attachment.type.startsWith("image/")) {
            const { data: signed, error: signedErr } = await supabase.storage
              .from("chatmalik-attachments").createSignedUrl(attachment.path, 300);
            if (signedErr || !signed?.signedUrl) return json({ error: "تعذر فتح الصورة المرفقة للمحرك الاحتياطي." }, 400);
            const imageResponse = await fetch(signed.signedUrl);
            if (!imageResponse.ok) return json({ error: "تعذر تحميل الصورة للمحرك الاحتياطي." }, 400);
            const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
            if (imageBytes.length > 12 * 1024 * 1024) return json({ error: "حجم الصورة المرفقة يتجاوز 12 ميغابايت." }, 413);
            let binary = "";
            for (let offset = 0; offset < imageBytes.length; offset += 0x8000) {
              binary += String.fromCharCode(...imageBytes.subarray(offset, Math.min(offset + 0x8000, imageBytes.length)));
            }
            latestParts.push({ inlineData: { mimeType: attachment.type, data: btoa(binary) } });
          } else if (typeof attachment?.text_content === "string") {
            if (attachment.text_content.length > 120000) return json({ error: "الملف النصي أكبر من الحد المسموح للتحليل." }, 413);
            latestParts.push({ text: "محتوى الملف " + String(attachment.name || "attachment").slice(0, 160) + ":\n" + attachment.text_content });
          }
        }
        geminiContents[geminiContents.length - 1].parts = latestParts;
      }
      try {
        const geminiResponse = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          {
            method: "POST",
            headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: instructions }] },
              contents: geminiContents,
              generationConfig: { maxOutputTokens: 900, temperature: 0.7 },
            }),
            signal: AbortSignal.timeout(45000),
          },
        );
        const geminiResult = await geminiResponse.json().catch(() => ({}));
        if (!geminiResponse.ok) {
          console.error("Gemini text fallback error:", geminiResponse.status, geminiResult?.error?.message || "request failed");
          if (geminiResponse.status === 429) return json({ error: "تم بلوغ الحصة المجانية المؤقتة لدى Groq وGemini. انتظر تجدد الحصة ثم حاول مجدداً. لا توجد أي خدمة مدفوعة تعمل كبديل." }, 429);
          return json({ error: "تعذر على مزود Gemini الاحتياطي تنفيذ الطلب حالياً. لم يتم استخدام أي مزود مدفوع." }, 503);
        }
        const candidateParts = geminiResult?.candidates?.[0]?.content?.parts || [];
        const geminiText = candidateParts.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join("\n").trim();
        if (!geminiText) return json({ error: "وصل رد فارغ من مزود Gemini الاحتياطي." }, 502);
        result = { output: [{ content: [{ type: "output_text", text: geminiText }] }] };
        provider = "gemini";
      } catch (error) {
        console.error("Gemini text fallback request failed:", error);
        return json({ error: "تعذر الاتصال بمزود Gemini الاحتياطي. حاول مجدداً لاحقاً." }, 503);
      }
    }

    const reply = extractOutputText(result);
    if (!reply) return json({ error: "وصل رد فارغ من نموذج الذكاء الاصطناعي." }, 502);

    const { error: insertError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });
    if (insertError) return json({ error: "تم توليد الإجابة لكن تعذر حفظها في سجل المحادثة." }, 500);

    // Automatic AI memory summarization is paused to avoid a second provider request per message. Existing private memory is still loaded above.

    return json({ reply, ai_provider: provider });
  } catch (error) {
    console.error("chatmalik-chat error:", error);
    return json({ error: "حدث خطأ داخلي غير متوقع. حاول مجدداً." }, 500);
  }
});