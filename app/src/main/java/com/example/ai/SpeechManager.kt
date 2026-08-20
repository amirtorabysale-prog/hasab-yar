package com.example.ai

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.example.data.model.DocumentType
import com.example.data.model.SpeechPreset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale

class SpeechManager(private val context: Context) {

    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private val _isPaused = MutableStateFlow(false)
    val isPaused: StateFlow<Boolean> = _isPaused.asStateFlow()

    private val _transcript = MutableStateFlow("")
    val transcript: StateFlow<String> = _transcript.asStateFlow()

    private val _audioAmplitude = MutableStateFlow(0f)
    val audioAmplitude: StateFlow<Float> = _audioAmplitude.asStateFlow()

    private var speechRecognizer: SpeechRecognizer? = null
    private var simulationJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.Main)

    val samplePresets = listOf(
        SpeechPreset(
            id = "p1",
            title = "خرید لپ‌تاپ پارس رایانه (کامل)",
            transcript = "فاکتور خرید از شرکت پارس رایانه، تاریخ بیست و هشت مرداد هزار و چهارصد و پنج، شماره فاکتور ۱۲۴۵، مبلغ قبل مالیات صد و بیست میلیون تومان، مالیات دوازده میلیون، جمع صد و سی و دو میلیون، بابت خرید دو دستگاه لپ‌تاپ.",
            documentType = DocumentType.PURCHASE
        ),
        SpeechPreset(
            id = "p2",
            title = "هزینه اینترنت ایرانسل",
            transcript = "هزینه اشتراک پهنای باند و اینترنت فیبر نوری از ایرانسل به مبلغ چهار میلیون و صد و هشتاد هزار تومان تاریخ بیست و پنج مرداد پرداخت شد.",
            documentType = DocumentType.EXPENSE
        ),
        SpeechPreset(
            id = "p3",
            title = "فروش مانیتور فروشگاه آرمان",
            transcript = "فاکتور فروش شماره ۷۷۰۱ به فروشگاه آرمان به مبلغ صد و پنجاه و پنج میلیون تومان شامل تخفیف چهار و نیم میلیون تومان، واریز به حساب ملت.",
            documentType = DocumentType.SALE
        ),
        SpeechPreset(
            id = "p4",
            title = "سند ناقص (بدون طرف حساب - تست هوش)",
            transcript = "هزینه سوخت و بنزین خودروی شرکت مبلغ چهارصد و پنجاه هزار تومان کارت کشیده شد.",
            documentType = DocumentType.EXPENSE
        ),
        SpeechPreset(
            id = "p5",
            title = "فاکتور با مغایرت ریاضی (تست اعتبارسنجی)",
            transcript = "فاکتور خرید کابل شبکه از شرکت پارس رایانه، شماره فاکتور ۱۲۹۰، پایه چهل و پنج میلیون، مالیات پنج میلیون، جمع پنجاه و دو میلیون تومان.",
            documentType = DocumentType.PURCHASE
        )
    )

    fun startListening() {
        _isListening.value = true
        _isPaused.value = false
        _transcript.value = ""

        // Try initializing system speech recognizer if available
        if (SpeechRecognizer.isRecognitionAvailable(context)) {
            try {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
                    setRecognitionListener(object : RecognitionListener {
                        override fun onReadyForSpeech(params: Bundle?) {}
                        override fun onBeginningOfSpeech() {}
                        override fun onRmsChanged(rmsdB: Float) {
                            _audioAmplitude.value = (rmsdB / 10f).coerceIn(0.1f, 1f)
                        }
                        override fun onBufferReceived(buffer: ByteArray?) {}
                        override fun onEndOfSpeech() {
                            _isListening.value = false
                        }
                        override fun onError(error: Int) {
                            // Fallback gracefully to simulation if mic is unavailable or blocked in emulator
                            simulateLiveVoice()
                        }
                        override fun onResults(results: Bundle?) {
                            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            if (!matches.isNullOrEmpty()) {
                                _transcript.value = matches[0]
                            }
                            _isListening.value = false
                        }
                        override fun onPartialResults(partialResults: Bundle?) {
                            val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            if (!matches.isNullOrEmpty()) {
                                _transcript.value = matches[0]
                            }
                        }
                        override fun onEvent(eventType: Int, params: Bundle?) {}
                    })
                }

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fa-IR")
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                }
                speechRecognizer?.startListening(intent)
                return
            } catch (e: Exception) {
                // Fall through to simulation
            }
        }

        simulateLiveVoice()
    }

    private fun simulateLiveVoice() {
        simulationJob?.cancel()
        simulationJob = scope.launch {
            val words = listOf(
                "فاکتور", "خرید", "از", "شرکت", "پارس", "رایانه", "،",
                "شماره", "۱۲۴۵", "،",
                "مبلغ", "صد", "و", "سی", "و", "دو", "میلیون", "تومان", "،",
                "تاریخ", "بیست", "و", "هشت", "مرداد", "،",
                "بابت", "خرید", "لپ‌تاپ", "تینک‌پد"
            )
            val sb = StringBuilder()
            for (word in words) {
                if (!_isListening.value) break
                sb.append(word).append(" ")
                _transcript.value = sb.toString().trim()
                _audioAmplitude.value = (0.3f + Math.random().toFloat() * 0.7f)
                delay(220)
            }
            _audioAmplitude.value = 0f
            _isListening.value = false
        }
    }

    fun stopListening() {
        _isListening.value = false
        _isPaused.value = false
        simulationJob?.cancel()
        try {
            speechRecognizer?.stopListening()
            speechRecognizer?.destroy()
        } catch (e: Exception) {}
        speechRecognizer = null
    }

    fun pauseListening() {
        _isPaused.value = true
    }

    fun resumeListening() {
        _isPaused.value = false
    }

    fun setManualTranscript(text: String) {
        _transcript.value = text
    }
}
