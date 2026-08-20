package com.example.ai

import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentStatus
import com.example.data.model.DocumentType
import com.example.data.model.TransactionEntity
import com.example.util.PersianUtils

object AIAssistantEngine {

    fun generateAnswer(
        query: String,
        documents: List<DocumentEntity>,
        transactions: List<TransactionEntity>,
        currency: String = "تومان"
    ): String {
        val q = query.trim().lowercase()

        val needsReviewDocs = documents.filter { it.status == DocumentStatus.NEEDS_REVIEW }
        val approvedDocs = documents.filter { it.status == DocumentStatus.APPROVED }
        val purchases = documents.filter { it.type == DocumentType.PURCHASE }
        val sales = documents.filter { it.type == DocumentType.SALE }
        val expenses = documents.filter { it.type == DocumentType.EXPENSE }

        val totalPurchases = purchases.sumOf { it.total }
        val totalSales = sales.sumOf { it.total }
        val totalExpenses = expenses.sumOf { it.total }

        return when {
            q.contains("بررسی") || q.contains("ناقص") || q.contains("نقص") -> {
                if (needsReviewDocs.isEmpty()) {
                    "در حال حاضر تمام اسناد شما تأیید شده‌اند و هیچ سندی با وضعیت «نیازمند بررسی» وجود ندارد."
                } else {
                    val listStr = needsReviewDocs.take(3).joinToString("، ") { "${it.contactName.ifBlank { "بدون نام" }} (${PersianUtils.formatPrice(it.total, currency)})" }
                    "تعداد ${PersianUtils.toPersianDigits(needsReviewDocs.size.toString())} سند نیازمند بررسی است:\n$listStr\n\nپیشنهاد می‌شود از بخش اسناد یا ورود سریع، نواقص (طرف حساب یا مغایرت ریاضی) را اصلاح کنید."
                }
            }

            q.contains("هزینه") || q.contains("خرج") -> {
                "مجموع هزینه‌های جاری ثبت‌شده ${PersianUtils.formatPrice(totalExpenses, currency)} است که شامل سرفصل‌های اینترنت، حمل‌ونقل و ملزومات اداری می‌باشد."
            }

            q.contains("خرید") || q.contains("تجهیزات") -> {
                "مجموع فاکتورهای خرید ثبت‌شده برابر با ${PersianUtils.formatPrice(totalPurchases, currency)} است (تعداد ${PersianUtils.toPersianDigits(purchases.size.toString())} فاکتور)."
            }

            q.contains("فروش") || q.contains("درآمد") -> {
                "مجموع فروش‌های ثبت‌شده برابر با ${PersianUtils.formatPrice(totalSales, currency)} است."
            }

            q.contains("پارس رایانه") -> {
                val parsDocs = documents.filter { it.contactName.contains("پارس رایانه") }
                val parsSum = parsDocs.sumOf { it.total }
                "تعداد ${PersianUtils.toPersianDigits(parsDocs.size.toString())} فاکتور به نام «شرکت پارس رایانه» با مجموع مبلغ ${PersianUtils.formatPrice(parsSum, currency)} ثبت شده است."
            }

            q.contains("تراز") || q.contains("سود") || q.contains("زیان") -> {
                val net = totalSales - (totalPurchases + totalExpenses)
                val status = if (net >= 0) "سود ناخالص عملیاتی" else "زیان عملیاتی"
                "تراز مالی فعلی: $status برابر با ${PersianUtils.formatPrice(Math.abs(net), currency)} می‌باشد."
            }

            else -> {
                "بر اساس داده‌های ثبتی شرکت، تا این لحظه ${PersianUtils.toPersianDigits(documents.size.toString())} سند مالی به ثبت رسیده است (${PersianUtils.toPersianDigits(approvedDocs.size.toString())} تأییدشده و ${PersianUtils.toPersianDigits(needsReviewDocs.size.toString())} نیازمند بررسی). می‌توانید درباره فاکتورها، هزینه‌ها، طرف حساب‌ها یا مغایرت‌ها سوال بپرسید."
            }
        }
    }
}
