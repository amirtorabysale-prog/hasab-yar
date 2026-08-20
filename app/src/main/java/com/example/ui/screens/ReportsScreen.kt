package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.CompanyEntity
import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentType
import com.example.data.model.TransactionEntity
import com.example.ui.components.MetricCard
import com.example.ui.theme.*
import com.example.util.PersianUtils

@Composable
fun ReportsScreen(
    documents: List<DocumentEntity>,
    transactions: List<TransactionEntity>,
    activeCompany: CompanyEntity?
) {
    val currency = activeCompany?.currency ?: "تومان"

    val totalSales = documents.filter { it.type == DocumentType.SALE }.sumOf { it.total }
    val totalPurchases = documents.filter { it.type == DocumentType.PURCHASE }.sumOf { it.total }
    val totalExpenses = documents.filter { it.type == DocumentType.EXPENSE }.sumOf { it.total }
    val netProfit = totalSales - (totalPurchases + totalExpenses)
    val totalTax = documents.sumOf { it.tax }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Text("گزارش‌های جامع مالی و تراز عملکرد", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                MetricCard(
                    title = "فروش و درآمدها",
                    value = PersianUtils.formatPrice(totalSales, currency),
                    subtitle = "${documents.count { it.type == DocumentType.SALE }} فاکتور فروش",
                    icon = Icons.Default.TrendingUp,
                    accentColor = StatusGreen,
                    modifier = Modifier.weight(1f)
                )
                MetricCard(
                    title = "هزینه‌ها و خرید",
                    value = PersianUtils.formatPrice(totalPurchases + totalExpenses, currency),
                    subtitle = "تجهیزات و جاری",
                    icon = Icons.Default.TrendingDown,
                    accentColor = StatusRed,
                    modifier = Modifier.weight(1f)
                )
            }
        }

        // P&L Statement Card
        item {
            Card(
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text("صورت سود و زیان دوره‌ای برآوردی", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    HorizontalDivider()

                    ReportRowItem("درآمد عملیاتی حاصل از فروش:", PersianUtils.formatPrice(totalSales, currency), StatusGreen)
                    ReportRowItem("بهای تمام شده کالای خریداری شده:", PersianUtils.formatPrice(totalPurchases, currency), StatusRed)
                    ReportRowItem("هزینه‌های اداری، عمومی و توزیع:", PersianUtils.formatPrice(totalExpenses, currency), StatusRed)
                    ReportRowItem("مالیات بر ارزش افزوده دوره:", PersianUtils.formatPrice(totalTax, currency), StatusYellowDark)

                    HorizontalDivider()

                    ReportRowItem(
                        "سود (زیان) خالص دوره:",
                        PersianUtils.formatPrice(netProfit, currency),
                        if (netProfit >= 0) PrimaryEmerald else StatusRed,
                        isBold = true
                    )
                }
            }
        }
    }
}

@Composable
private fun ReportRowItem(
    title: String,
    value: String,
    color: Color,
    isBold: Boolean = false
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(title, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            fontSize = if (isBold) 14.sp else 12.sp,
            fontWeight = if (isBold) FontWeight.Bold else FontWeight.Medium,
            color = color
        )
    }
}
