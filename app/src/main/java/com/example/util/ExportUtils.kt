package com.example.util

import com.example.data.model.DocumentEntity

object ExportUtils {

    fun generateExcelCsv(documents: List<DocumentEntity>, companyName: String = "شرکت پارس تجارت"): String {
        val sb = StringBuilder()
        sb.append("\uFEFF")
        sb.append("ردیف,نوع سند,طرف حساب,شماره فاکتور,تاریخ,مبلغ جزء,مالیات,تخفیف,مبلغ کل,سرفصل,روش پرداخت,وضعیت\n")

        documents.forEachIndexed { index, doc ->
            sb.append("${index + 1},")
            sb.append("\"${doc.type.titleFa}\",")
            sb.append("\"${doc.contactName}\",")
            sb.append("\"${doc.invoiceNumber}\",")
            sb.append("\"${doc.dateShamsi}\",")
            sb.append("${doc.subtotal},")
            sb.append("${doc.tax},")
            sb.append("${doc.discount},")
            sb.append("${doc.total},")
            sb.append("\"${doc.categoryName}\",")
            sb.append("\"${doc.paymentMethod}\",")
            sb.append("\"${doc.status.titleFa}\"\n")
        }
        return sb.toString()
    }

    fun generateSepidarExport(documents: List<DocumentEntity>, companyName: String = "شرکت پارس تجارت"): String =
        generateSepidarCsv(documents, companyName)

    fun generateSepidarCsv(documents: List<DocumentEntity>, companyName: String = "شرکت پارس تجارت"): String {
        val sb = StringBuilder()
        sb.append("\uFEFF")
        sb.append("// قالب ورود اطلاعات به سیستم مالی همکاران سیستم / سپیدار //\n")
        sb.append("کد حساب معین,کد تفصیلی,شماره سند,تاریخ سند,شرح سند,بدهکار,بستانکار,کد پیگیری\n")

        documents.forEach { doc ->
            val isDebit = doc.type.name == "PURCHASE" || doc.type.name == "EXPENSE"
            val debit = if (isDebit) doc.total else 0L
            val credit = if (!isDebit) doc.total else 0L
            sb.append("80101,9021,\"${doc.invoiceNumber}\",${doc.dateShamsi},\"${doc.description} - ${doc.contactName}\",$debit,$credit,\"${doc.id}\"\n")
        }
        return sb.toString()
    }

    fun generateHoloExport(documents: List<DocumentEntity>, companyName: String = "شرکت پارس تجارت"): String =
        generateHoloogCsv(documents, companyName)

    fun generateHoloogCsv(documents: List<DocumentEntity>, companyName: String = "شرکت پارس تجارت"): String {
        val sb = StringBuilder()
        sb.append("\uFEFF")
        sb.append("// خروجی استاندارد نرم‌افزار حسابداری هلو //\n")
        sb.append("کد طرف حساب;نام طرف حساب;شماره فاکتور;تاریخ;مبلغ کل;تخفیف;مالیات;شرح فاکتور\n")
        documents.forEach { doc ->
            sb.append("${doc.id};${doc.contactName};${doc.invoiceNumber};${doc.dateShamsi};${doc.total};${doc.discount};${doc.tax};${doc.description}\n")
        }
        return sb.toString()
    }

    fun generateTextFinancialReport(documents: List<DocumentEntity>, companyName: String, currency: String = "تومان"): String {
        val totalPurchases = documents.filter { it.type.name == "PURCHASE" }.sumOf { it.total }
        val totalSales = documents.filter { it.type.name == "SALE" }.sumOf { it.total }
        val totalExpenses = documents.filter { it.type.name == "EXPENSE" }.sumOf { it.total }
        val netProfit = totalSales - (totalPurchases + totalExpenses)

        return """
========================================
   گزارش جامع مالی و خلاصه عملکرد
   شرکت: $companyName
   تاریخ: ${PersianUtils.getTodayShamsi()}
========================================

📊 خلاصه شاخص‌های کلیدی:
• تعداد کل اسناد مالی: ${documents.size} سند
• مجموع فروش و درآمد: ${PersianUtils.formatPrice(totalSales, currency)}
• مجموع خرید تجهیزات و کالا: ${PersianUtils.formatPrice(totalPurchases, currency)}
• مجموع هزینه‌های جاری: ${PersianUtils.formatPrice(totalExpenses, currency)}
----------------------------------------
📈 تراز عملیاتی تقریبی: ${PersianUtils.formatPrice(netProfit, currency)}

تفکیک وضعیت اسناد:
• تأییدشده: ${documents.count { it.status.name == "APPROVED" }}
• نیازمند بررسی: ${documents.count { it.status.name == "NEEDS_REVIEW" }}
• پیش‌نویس: ${documents.count { it.status.name == "DRAFT" }}

تهیه شده توسط سیستم هوشمند HesabYar AI
        """.trimIndent()
    }

    fun generateJsonSummary(documents: List<DocumentEntity>): String {
        val count = documents.size
        val total = documents.sumOf { it.total }
        return """
        {
          "application": "HesabYar AI",
          "version": "2.4",
          "total_documents": $count,
          "total_amount": $total,
          "export_timestamp": "${System.currentTimeMillis()}"
        }
        """.trimIndent()
    }
}
