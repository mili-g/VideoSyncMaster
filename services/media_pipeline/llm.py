import importlib.util
import json
import os
import re
import sys
import ast

from model_profiles import MODELS_ROOT


class LLMTranslator:
    def __init__(self, model_dir=None, api_key=None, base_url=None, model=None, enable_local_llm=False):
        self.api_key = api_key
        self.base_url = base_url
        self.model_name = model
        self.enable_local_llm = enable_local_llm
        self.use_external = False
        self.model = None
        self.tokenizer = None

        has_external_config = bool(str(self.api_key or "").strip()) and bool(str(self.base_url or "").strip()) and bool(str(self.model_name or "").strip())

        if has_external_config:
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
            if self.api_key and not has_external_config:
                print("[LLMTranslator] External translation config is incomplete. Falling back to Local Qwen Model.")
            else:
                print("[LLMTranslator] No API Key provided. Using Local Qwen Model.")
            self._init_local_model(model_dir)

    def _init_local_model(self, model_dir=None):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.model_dir = self._resolve_local_model_dir(model_dir)

        if not self.model_dir:
            print("[LLMTranslator] Local text model directory is unavailable. Skipping local LLM initialization.")
            self.model = None
            self.tokenizer = None
            return

        print(f"Initializing Local LLM from {self.model_dir}...")
        
        # Initialize tokenizer first (independent of model quantization)
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_dir,
                trust_remote_code=True,
                local_files_only=True,
            )
        except Exception as e:
            print(f"Failed to load tokenizer: {e}")
            self.model = None
            return

        accelerate_available = self._ensure_accelerate_available()
        if not accelerate_available:
            print("[LLMTranslator] accelerate is unavailable. Falling back to direct model loading without device_map.")
            self.model = self._load_local_model_without_accelerate(torch, AutoModelForCausalLM)
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

            four_bit_kwargs = {
                "trust_remote_code": True,
                "quantization_config": quantization_config,
            }
            if torch.cuda.is_available():
                four_bit_kwargs["device_map"] = {"": 0}

            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_dir,
                local_files_only=True,
                **four_bit_kwargs
            )
            print("Local LLM Initialized successfully (4-bit).")
        except Exception as e:
            print(f"Failed to load Local LLM (4-bit attempt): {e}")
            # Fallback to fp16
            try:
                 print("Retrying with direct device load...")
                 self.model = self._load_local_model_without_accelerate(torch, AutoModelForCausalLM)
            except Exception as e2:
                print(f"Failed to load Local LLM: {e2}")
                self.model = None

    def _ensure_accelerate_available(self):
        if importlib.util.find_spec("accelerate") is not None:
            return True

        try:
            from dependency_manager import ensure_package_installed
            if ensure_package_installed("accelerate", "accelerate>=1.12.0"):
                return importlib.util.find_spec("accelerate") is not None
        except Exception as error:
            print(f"[LLMTranslator] Failed to auto-install accelerate: {error}")

        return False

    def _load_local_model_without_accelerate(self, torch, auto_model_cls):
        candidate_devices = ["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]

        last_error = None
        for target_device in candidate_devices:
            try:
                model_kwargs = {
                    "trust_remote_code": True,
                    "local_files_only": True,
                    "torch_dtype": torch.float16 if target_device == "cuda" else torch.float32,
                }
                model = auto_model_cls.from_pretrained(self.model_dir, **model_kwargs)
                model = model.to(target_device)
                print(f"Local LLM Initialized successfully ({target_device}, direct load).")
                return model
            except Exception as error:
                last_error = error
                print(f"Failed to load Local LLM on {target_device}: {error}")
                try:
                    if target_device == "cuda" and torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass

        print(f"Failed to load Local LLM without accelerate: {last_error}")
        return None

    def _resolve_local_model_dir(self, model_dir=None):
        default_dir = os.path.join(MODELS_ROOT, "Qwen2.5-7B-Instruct")
        requested_dir = os.path.abspath(model_dir) if model_dir else None

        for candidate_dir in [requested_dir, default_dir]:
            if not candidate_dir:
                continue
            candidate_config = os.path.join(candidate_dir, "config.json")
            candidate_tokenizer = os.path.join(candidate_dir, "tokenizer_config.json")
            if os.path.exists(candidate_config) or os.path.exists(candidate_tokenizer):
                return candidate_dir

        if requested_dir:
            print(
                f"[LLMTranslator] Provided model_dir does not look like a local text model: {requested_dir}. "
                f"Fallback default is also unavailable: {default_dir}"
            )
        else:
            print(f"[LLMTranslator] Default local text model directory is unavailable: {default_dir}")
        return None

    def translate(self, text, target_lang="English"):
        if self.use_external:
            return self._translate_external(text, target_lang)
        else:
            return self._translate_local(text, target_lang)

    def chat_complete(self, messages, temperature=0.1, max_new_tokens=1024):
        if self.use_external:
            return self._chat_complete_external(messages, temperature, max_new_tokens)
        return self._chat_complete_local(messages, temperature, max_new_tokens)

    def _get_external_api_url(self):
        url = (self.base_url or "").strip().rstrip("/")
        if not url:
            raise RuntimeError("External translation API URL is empty.")
        return url

    def _translate_external(self, text, target_lang):
        try:
            url = self._get_external_api_url()
            
            prompt = f"Translate the following text into {target_lang}. Output ONLY the translated text. Do not output the original text. Do not explain context. Do not provide citations or references.\n\nText: {text}"
            
            payload = {
                "model": self.model_name,
                "messages": [
                    {"role": "system", "content": "You are a professional translator."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.7
            }
            
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

    def _chat_complete_external(self, messages, temperature, max_new_tokens):
        url = self._get_external_api_url()
        payload = {
            "model": self.model_name,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_new_tokens,
        }

        response = self.session.post(url, json=payload, timeout=120)
        if response.status_code != 200:
            raise RuntimeError(f"API Error {response.status_code}: {response.text}")

        data = response.json()
        if "choices" not in data or not data["choices"]:
            raise RuntimeError(f"Invalid API Response: {data}")

        return data["choices"][0]["message"]["content"].strip()

    def _clean_response(self, text):
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
        """
        if not texts:
            return []
        if self.use_external:
            return self._translate_batch_external(texts, target_lang)
        return self._translate_batch_local(texts, target_lang)

    def _extract_json_list_from_text(self, raw_content):
        cleaned = self._clean_response(raw_content or "")
        candidate = cleaned.strip()
        if candidate.startswith('```'):
            candidate = re.sub(r'^```(json)?\s*', '', candidate)
            candidate = re.sub(r'\s*```$', '', candidate)

        json_match = re.search(r'\[.*\]', candidate, flags=re.DOTALL)
        if json_match:
            candidate = json_match.group(0)

        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            try:
                parsed = ast.literal_eval(candidate)
            except Exception:
                parsed = None

        if not isinstance(parsed, list):
            raise RuntimeError(f"Batch translation response parse failed: {candidate[:200]}")

        return [str(item).strip() for item in parsed]

    def _translate_batch_external(self, texts, target_lang):
        results = []
        batch_size = 10
        total = len(texts)

        for i in range(0, total, batch_size):
            chunk = texts[i:i + batch_size]
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
                url = self._get_external_api_url()

                response = self.session.post(url, json=payload, timeout=120)  # Increased timeout

                if response.status_code != 200:
                    raise RuntimeError(f"Batch translation API error {response.status_code}: {response.text}")
                
                data = response.json()
                if "choices" in data and len(data["choices"]) > 0:
                    raw_content = data["choices"][0]["message"]["content"].strip()
                    batch_results = self._extract_json_list_from_text(raw_content)
                    if len(batch_results) != len(chunk):
                        raise RuntimeError(
                            f"Batch translation length mismatch. Expected {len(chunk)}, got {len(batch_results)}."
                        )
                    results.extend(batch_results)
                else:
                    raise RuntimeError("Batch translation response missing choices.")

            except Exception as e:
                print(f"[BatchTranslation] Exception: {e}")
                raise

        return results

    def _translate_batch_local(self, texts, target_lang):
        if not self.model or not self.tokenizer:
            raise RuntimeError(
                f"Local LLM is not available. Expected local translation model under {os.path.join(MODELS_ROOT, 'Qwen2.5-7B-Instruct')}"
            )

        results = []
        batch_size = 8
        total = len(texts)

        for index in range(0, total, batch_size):
            chunk = texts[index:index + batch_size]
            batch_results = self._translate_batch_local_chunk(chunk, target_lang)
            results.extend(batch_results)

        return results

    def _translate_batch_local_chunk(self, chunk, target_lang, depth=0):
        json_input = json.dumps(chunk, ensure_ascii=False)
        messages = [
            {
                "role": "system",
                "content": (
                    f"You are a professional translator. Translate each sentence into {target_lang}. "
                    "Output ONLY a valid JSON array of translated strings. "
                    "Keep the same order and same number of items. "
                    "Every input item must produce exactly one output item. "
                    "Do not merge, skip, summarize, or explain anything. "
                    "Do not output the original text."
                ),
            },
            {"role": "user", "content": json_input},
        ]
        raw_content = self._chat_complete_local(messages, temperature=0.05, max_new_tokens=1536)
        batch_results = self._extract_json_list_from_text(raw_content)
        if len(batch_results) == len(chunk):
            return batch_results

        print(
            f"[LocalBatchTranslation] Length mismatch at depth={depth}. "
            f"Expected {len(chunk)}, got {len(batch_results)}. Falling back."
        )

        if len(chunk) == 1:
            single_result = self._translate_local(chunk[0], target_lang)
            cleaned_single = self._clean_response(single_result or "").strip()
            if not cleaned_single:
                raise RuntimeError("Local single-item translation fallback returned empty text.")
            return [cleaned_single]

        midpoint = max(1, len(chunk) // 2)
        left_results = self._translate_batch_local_chunk(chunk[:midpoint], target_lang, depth + 1)
        right_results = self._translate_batch_local_chunk(chunk[midpoint:], target_lang, depth + 1)
        return left_results + right_results

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
            attention_mask=model_inputs.attention_mask,
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

    def _chat_complete_local(self, messages, temperature, max_new_tokens):
        if not self.model or not self.tokenizer:
            raise RuntimeError(
                f"Local LLM is not available. Expected local translation model under {os.path.join(MODELS_ROOT, 'Qwen2.5-7B-Instruct')}"
            )

        text_input = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )

        model_inputs = self.tokenizer([text_input], return_tensors="pt").to(self.model.device)
        generated_ids = self.model.generate(
            model_inputs.input_ids,
            attention_mask=model_inputs.attention_mask,
            max_new_tokens=max_new_tokens,
            do_sample=temperature > 0,
            temperature=max(temperature, 0.01),
            top_p=0.9,
            repetition_penalty=1.05
        )

        generated_ids = [
            output_ids[len(input_ids):]
            for input_ids, output_ids in zip(model_inputs.input_ids, generated_ids)
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
