import os
import sys

class LLMTranslator:
    def __init__(self, model_dir=None, api_key=None, base_url=None, model=None):
        self.api_key = api_key
        self.base_url = base_url
        self.model_name = model
        self.use_external = False
        self.model = None
        self.tokenizer = None

        if self.api_key:
            print(f"[LLMTranslator] Using External API: {self.base_url} (Model: {self.model_name})")
            self.use_external = True
            
            # Use requests for HTTP calls
            import requests
            self.requests = requests
            self.session = requests.Session()
            self.session.headers.update({
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            })
        else:
            # Fallback to Local Qwen
            print("[LLMTranslator] No API Key provided. Using Local Qwen Model.")
            self._init_local_model(model_dir)

    def _init_local_model(self, model_dir=None):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.model_dir = self._resolve_local_model_dir(model_dir)

        print(f"Initializing Local LLM from {self.model_dir}...")
        
        # Initialize tokenizer first (independent of model quantization)
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(self.model_dir, trust_remote_code=True)
        except Exception as e:
            print(f"Failed to load tokenizer: {e}")
            self.model = None
            return

        # Try to load model with 4-bit quantization
        try:
            try:
                import bitsandbytes
                print(f"bitsandbytes version: {bitsandbytes.__version__}")
            except ImportError:
                print("bitsandbytes not found")

            from transformers import BitsAndBytesConfig
            quantization_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4"
            )
            
            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_dir, 
                device_map="auto", 
                trust_remote_code=True,
                quantization_config=quantization_config
            )
            print("Local LLM Initialized successfully (4-bit).")
        except Exception as e:
            print(f"Failed to load Local LLM (4-bit attempt): {e}")
            # Fallback to fp16
            try:
                 print("Retrying with fp16...")
                 self.model = AutoModelForCausalLM.from_pretrained(
                    self.model_dir,
                    device_map="auto",
                    trust_remote_code=True,
                    torch_dtype=torch.float16
                )
            except Exception as e2:
                print(f"Failed to load Local LLM: {e2}")
                self.model = None

    def _resolve_local_model_dir(self, model_dir=None):
        # Path Logic
        base_dir = os.path.dirname(os.path.abspath(__file__))

        # Candidates
        # 1. Dev: ../models/Qwen2.5-7B-Instruct
        path_dev = os.path.join(base_dir, "..", "models", "Qwen2.5-7B-Instruct")
        # 2. Prod: ../../models/Qwen2.5-7B-Instruct (resources/backend -> resources -> root)
        path_prod = os.path.join(base_dir, "..", "..", "models", "Qwen2.5-7B-Instruct")

        default_dir = path_prod if os.path.exists(path_prod) else path_dev

        if not model_dir:
            return default_dir

        candidate_dir = os.path.abspath(model_dir)
        candidate_config = os.path.join(candidate_dir, "config.json")
        candidate_tokenizer = os.path.join(candidate_dir, "tokenizer_config.json")

        if os.path.exists(candidate_config) or os.path.exists(candidate_tokenizer):
            return candidate_dir

        print(
            f"[LLMTranslator] Provided model_dir does not look like a local text model: {candidate_dir}. "
            f"Falling back to {default_dir}"
        )
        return default_dir

    def translate(self, text, target_lang="English"):
        if self.use_external:
            return self._translate_external(text, target_lang)
        else:
            return self._translate_local(text, target_lang)

    def _translate_external(self, text, target_lang):
        try:
            # Smart URL construction
            base = self.base_url.rstrip('/')
            if base.endswith('/chat/completions'):
                url = base
            else:
                url = f"{base}/chat/completions"
            
            prompt = f"Translate the following text into {target_lang}. Output ONLY the translated text. Do not output the original text. Do not explain context. Do not provide citations or references.\n\nText: {text}"
            
            payload = {
                "model": self.model_name,
                "messages": [
                    {"role": "system", "content": "You are a professional translator."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.7
            }
            
            # Fail-fast: Raise exception on error
            response = self.session.post(url, json=payload, timeout=60)
            
            if response.status_code != 200:
                raise Exception(f"API Error {response.status_code}: {response.text}")
                
            data = response.json()
            if "choices" in data and len(data["choices"]) > 0:
                raw_content = data["choices"][0]["message"]["content"].strip()
                return self._clean_response(raw_content)
            else:
                raise Exception(f"Invalid API Response: {data}")
                
        except Exception as e:
            # Raise immediately to let main.py catch and report, preventing fallback or silent failure
            print(f"[ExternalTranslation] Failed: {e}")
            raise e

    def _clean_response(self, text):
        import re
        # 1. Remove DeepSeek R1 style <think>...</think>
        text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
        
        # 2. Remove "Thought for a second" style lines (often likely quoted)
        text = re.sub(r'^[\s>]*\*?Thought.*?(?:\n|$)', '', text, flags=re.IGNORECASE | re.MULTILINE)
        
        # 3. Aggressive Truncation for Explanations/Citations
        # Truncate at first occurrence of common explanation headers
        patterns = [
            r'\*\*?参考',  # **参考依据**, **参考**, 参考
            r'-+\s*参考', # ---参考资料
            r'Reference:',
            r'Sources:',
            r'\*\*?Explanation',
            r'^Translation Note:',
            r'---',        # Generic separator often used before footers
        ]
        
        for p in patterns:
            match = re.search(p, text, flags=re.IGNORECASE | re.MULTILINE)
            if match:
                # Special check for generic '---': Only truncate if it's in the last 50% of text 
                # (avoid killing dashed lists in short texts, though unlikely in trans)
                if p == r'---':
                    if match.start() > len(text) * 0.5:
                         text = text[:match.start()]
                else:
                    text = text[:match.start()]
                
        # 4. Remove leading/trailing quotes if the model wrapped the output
        text = text.strip()
        if text.startswith('"') and text.endswith('"'):
            text = text[1:-1]
        
        return text.strip()

    def translate_batch(self, texts, target_lang="English"):
        """
        Translates a list of texts in batches.
        Only implemented for External API for now to speed up network requests.
        """
        if not self.use_external:
            # Fallback to loop for local model (or implement batch inference later)
            results = []
            for t in texts:
                results.append(self._translate_local(t, target_lang))
            return results

        import json
        import re
        import ast
        
        results = []
        batch_size = 10 # Smaller batch for stability
        total = len(texts)
        
        for i in range(0, total, batch_size):
            chunk = texts[i:i+batch_size]
            
            # Construct Prompt
            json_input = json.dumps(chunk, ensure_ascii=False)
            
            prompt = f"""You are a professional translator. Translate the following list of sentences into {target_lang}.
Input is a JSON list of strings. Output ONLY a valid JSON list of translated strings.
Maintain the same order and length. Do not output original text. Do not explain.

Input:
{json_input}"""

            payload = {
                "model": self.model_name,
                "messages": [
                    {"role": "system", "content": "You are a professional translator."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.3 
            }
            
            try:
                # Smart URL construction
                base = self.base_url.rstrip('/')
                if base.endswith('/chat/completions'):
                    url = base
                else:
                    url = f"{base}/chat/completions"

                response = self.session.post(url, json=payload, timeout=120)  # Increased timeout

                if response.status_code != 200:
                    raise RuntimeError(f"Batch translation API error {response.status_code}: {response.text}")
                
                data = response.json()
                if "choices" in data and len(data["choices"]) > 0:
                    raw_content = data["choices"][0]["message"]["content"].strip()
                    
                    # 1. Pre-clean raw content (remove thoughts, citations, etc.)
                    # This helps avoid greedy regex capturing footer citations like [1]
                    raw_content = self._clean_response(raw_content)

                    # 2. Extract JSON candidates
                    # Try to find the largest [...] block, but since we cleaned footer citations, greedy matching is safer now.
                    # Also handle markdown code blocks wrap
                    if raw_content.startswith('```'):
                         raw_content = re.sub(r'^```(json)?\s*', '', raw_content)
                         raw_content = re.sub(r'\s*```$', '', raw_content)

                    json_match = re.search(r'\[.*\]', raw_content, flags=re.DOTALL)
                    if json_match:
                         raw_content = json_match.group(0)
                    
                    batch_results = None
                    # 3. Try parsing
                    try:
                        batch_results = json.loads(raw_content)
                    except json.JSONDecodeError:
                        # Fallback: Try AST (Python literal) parsing for loose syntax (single quotes, trailing commas)
                        try:
                            batch_results = ast.literal_eval(raw_content)
                        except:
                            pass
                    
                    if isinstance(batch_results, list):
                        if len(batch_results) != len(chunk):
                            raise RuntimeError(
                                f"Batch translation length mismatch. Expected {len(chunk)}, got {len(batch_results)}."
                            )
                        
                        # 4. Final clean of items (just in case)
                        cleaned_results = [str(txt).strip() for txt in batch_results]
                        results.extend(cleaned_results)
                    else:
                        raise RuntimeError(f"Batch translation response parse failed: {raw_content[:200]}")
                else:
                    raise RuntimeError("Batch translation response missing choices.")

            except Exception as e:
                print(f"[BatchTranslation] Exception: {e}")
                raise
                
        return results

    def _translate_local(self, text, target_lang):
        if not self.model:
            return None
        
        messages = [
            {"role": "system", "content": f"You are a high-level translator. Translate the given text into {target_lang}. Output ONLY the translated text. Do not output the original text. Do not explain."},
            {"role": "user", "content": text}
        ]
        
        text_input = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )
        
        model_inputs = self.tokenizer([text_input], return_tensors="pt").to(self.model.device)
        
        generated_ids = self.model.generate(
            model_inputs.input_ids,
            max_new_tokens=512,
            do_sample=True,       
            temperature=0.7,      
            top_p=0.9,
            repetition_penalty=1.1
        )
        
        generated_ids = [
            output_ids[len(input_ids):] for input_ids, output_ids in zip(model_inputs.input_ids, generated_ids)
        ]
        
        response = self.tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0]
        return response.strip()

    def cleanup(self):
        """
        Release model and tokenizer from memory.
        """
        if self.use_external:
            if hasattr(self, 'session'):
                self.session.close()
            return

        print("Cleaning up LLM from VRAM...", flush=True)
        if hasattr(self, 'model'):
            del self.model
        if hasattr(self, 'tokenizer'):
            del self.tokenizer
        
        import gc
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print("LLM cleanup complete.", flush=True)
