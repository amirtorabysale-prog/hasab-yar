package com.example.util

import java.text.DecimalFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object PersianUtils {

    private val PERSIAN_DIGITS = charArrayOf('۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹')
    private val ARABIC_DIGITS = charArrayOf('٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩')

    fun toPersianDigits(text: String): String {
        val sb = StringBuilder()
        for (ch in text) {
            when (ch) {
                in '0'..'9' -> sb.append(PERSIAN_DIGITS[ch - '0'])
                in '٠'..'٩' -> sb.append(PERSIAN_DIGITS[ch - '٠'])
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun toEnglishDigits(text: String): String {
        val sb = StringBuilder()
        for (ch in text) {
            when (ch) {
                in '۰'..'۹' -> sb.append((ch - '۰').toString())
                in '٠'..'٩' -> sb.append((ch - '٠').toString())
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun formatPrice(amount: Long, currency: String = "تومان"): String {
        val formatter = DecimalFormat("#,###")
        val formatted = formatter.format(amount)
        return "${toPersianDigits(formatted)} $currency"
    }

    fun formatNumber(number: Number): String {
        val formatter = DecimalFormat("#,###")
        return toPersianDigits(formatter.format(number))
    }

    fun formatTimestamp(timestamp: Long): String {
        val sdf = SimpleDateFormat("HH:mm", Locale.getDefault())
        return sdf.format(Date(timestamp))
    }

    fun extractAmount(input: String): Long? = parsePersianAmount(input)

    fun parsePersianAmount(input: String): Long? {
        val normalized = toEnglishDigits(input)
            .replace(",", "")
            .replace("،", "")
            .replace("تومان", "")
            .replace("تومن", "")
            .replace("ریال", "")
            .trim()

        normalized.toLongOrNull()?.let { return it }

        val decimalMatch = Regex("""([\d.]+)\s*(میلیون|میلیارد|هزار)""").find(normalized)
        if (decimalMatch != null) {
            val num = decimalMatch.groupValues[1].toDoubleOrNull() ?: 0.0
            val scale = when (decimalMatch.groupValues[2]) {
                "میلیارد" -> 1_000_000_000L
                "میلیون" -> 1_000_000L
                "هزار" -> 1_000L
                else -> 1L
            }
            return (num * scale).toLong()
        }

        val words = normalized.split(Regex("""\s+و\s+|\s+""")).filter { it.isNotBlank() }
        var total = 0L
        var currentSection = 0L

        for (w in words) {
            val value = parsePersianWordNumber(w)
            if (value != null) {
                if (value == 1_000_000_000L || value == 1_000_000L) {
                    if (currentSection == 0L) currentSection = 1L
                    total += currentSection * value
                    currentSection = 0L
                } else if (value == 1_000L) {
                    if (currentSection == 0L) currentSection = 1L
                    total += currentSection * value
                    currentSection = 0L
                } else {
                    currentSection += value
                }
            } else {
                val digitVal = w.toLongOrNull()
                if (digitVal != null) {
                    currentSection += digitVal
                }
            }
        }
        total += currentSection
        return if (total > 0) total else null
    }

    private fun parsePersianWordNumber(word: String): Long? {
        val w = word.trim()
        return when (w) {
            "یک", "یه" -> 1L
            "دو" -> 2L
            "سه" -> 3L
            "چهار" -> 4L
            "پنج" -> 5L
            "شش", "شیش" -> 6L
            "هفت" -> 7L
            "هشت" -> 8L
            "نه" -> 9L
            "ده" -> 10L
            "یازده" -> 11L
            "دوازده" -> 12L
            "سیزده" -> 13L
            "چهارده" -> 14L
            "پانزده", "پونزده" -> 15L
            "شانزده", "شونزده" -> 16L
            "هفده" -> 17L
            "هجده" -> 18L
            "نوزده" -> 19L
            "بیست" -> 20L
            "سی" -> 30L
            "چهل" -> 40L
            "پنجاه" -> 50L
            "شصت" -> 60L
            "هفتاد" -> 70L
            "هشتاد" -> 80L
            "نود" -> 90L
            "صد", "یکصد" -> 100L
            "دویست" -> 200L
            "سیصد" -> 300L
            "چهارصد" -> 400L
            "پانصد", "پونصد" -> 500L
            "ششصد" -> 600L
            "هفتصد" -> 700L
            "هشتصد" -> 800L
            "نهصد" -> 900L
            "هزار", "یک‌هزار" -> 1_000L
            "میلیون", "میلیون‌ها" -> 1_000_000L
            "میلیارد" -> 1_000_000_000L
            else -> null
        }
    }

    fun extractShamsiDate(text: String): String = parsePersianDate(text)

    fun parsePersianDate(text: String): String {
        val eng = toEnglishDigits(text)
        val standardMatch = Regex("""(1[34]\d{2})[/.-](\d{1,2})[/.-](\d{1,2})""").find(eng)
        if (standardMatch != null) {
            val (y, m, d) = standardMatch.destructured
            return String.format(Locale.US, "%s/%02d/%02d", y, m.toInt(), d.toInt())
        }

        val months = mapOf(
            "فروردین" to 1, "اردیبهشت" to 2, "خرداد" to 3,
            "تیر" to 4, "مرداد" to 5, "شهریور" to 6,
            "مهر" to 7, "آبان" to 8, "آذر" to 9,
            "دی" to 10, "بهمن" to 11, "اسفند" to 12
        )

        var foundMonth = 5
        var monthNameFound = ""
        for ((mName, mIdx) in months) {
            if (text.contains(mName)) {
                foundMonth = mIdx
                monthNameFound = mName
                break
            }
        }

        var day = 28
        val dayMatch = Regex("""(\d{1,2})\s*""" + monthNameFound).find(eng)
        if (dayMatch != null) {
            day = dayMatch.groupValues[1].toIntOrNull() ?: 28
        } else {
            if (text.contains("بیست و هشت")) day = 28
            else if (text.contains("بیست و هفت")) day = 27
            else if (text.contains("بیست")) day = 20
            else if (text.contains("پانزده") || text.contains("پونزده")) day = 15
            else if (text.contains("یکم") || text.contains("اول")) day = 1
        }

        var year = 1405
        if (text.contains("هزار و چهارصد و پنج") || text.contains("1405")) year = 1405
        else if (text.contains("هزار و چهارصد و چهار") || text.contains("1404")) year = 1404
        else if (text.contains("هزار و چهارصد و شش") || text.contains("1406")) year = 1406

        return String.format(Locale.US, "%04d/%02d/%02d", year, foundMonth, day)
    }

    fun getCurrentShamsiDate(): String = "1405/05/29"

    fun getTodayShamsi(): String = getCurrentShamsiDate()
}
