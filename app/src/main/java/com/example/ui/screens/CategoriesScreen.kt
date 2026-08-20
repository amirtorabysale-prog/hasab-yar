package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.AccountingRuleEntity
import com.example.data.model.CategoryEntity
import com.example.data.model.DocumentEntity
import com.example.ui.theme.PrimaryEmerald
import com.example.ui.theme.SecondaryTeal
import com.example.util.PersianUtils

@Composable
fun CategoriesScreen(
    categories: List<CategoryEntity>,
    documents: List<DocumentEntity>,
    rules: List<AccountingRuleEntity>,
    onAddRule: (String, String) -> Unit
) {
    var showAddRuleDialog by remember { mutableStateOf(false) }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showAddRuleDialog = true },
                containerColor = PrimaryEmerald,
                contentColor = Color.White,
                modifier = Modifier.testTag("add_rule_fab")
            ) {
                Icon(Icons.Default.Rule, contentDescription = "افزودن قانون هوشمند")
            }
        }
    ) { paddingValues ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Intelligent Category Matching Rules
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = PrimaryEmerald.copy(alpha = 0.08f)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(Icons.Default.AutoAwesome, contentDescription = null, tint = PrimaryEmerald)
                            Text(
                                "قوانین یادگیری خودکار هوش مصنوعی (AI Rules)",
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                                color = PrimaryEmerald
                            )
                        }
                        Text(
                            "سیستم به صورت خودکار کلمات کلیدی گفتار و فاکتورها را به دسته‌بندی و سرفصل معین متناظر نگاشت می‌کند.",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // Rules List
            item {
                Text("قوانین فعال نگاشت صوتی:", fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }

            items(rules) { rule ->
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surface,
                    shadowElevation = 1.dp,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(SecondaryTeal)
                            )
                            Text("کلمه کلیدی: «${rule.keyword}»", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        }

                        Text(
                            "← سرفصل: ${rule.suggestedCategoryName}",
                            color = PrimaryEmerald,
                            fontWeight = FontWeight.Bold,
                            fontSize = 12.sp
                        )
                    }
                }
            }

            // Categories Header
            item {
                Text("سرفصل‌های هزینه‌ای و درآمدی تعریف‌شده:", fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }

            items(categories) { cat ->
                val count = documents.count { it.categoryName == cat.name }
                val totalAmount = documents.filter { it.categoryName == cat.name }.sumOf { it.total }

                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            Icon(Icons.Default.Folder, contentDescription = null, tint = PrimaryEmerald)
                            Column {
                                Text(cat.name, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text("نوع حساب: ${cat.type} • ${PersianUtils.toPersianDigits(count.toString())} سند", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }

                        Text(
                            PersianUtils.formatPrice(totalAmount),
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
            }
        }
    }

    if (showAddRuleDialog) {
        var keyword by remember { mutableStateOf("") }
        var categoryName by remember { mutableStateOf(categories.firstOrNull()?.name ?: "هزینه‌های عمومی") }

        AlertDialog(
            onDismissRequest = { showAddRuleDialog = false },
            title = { Text("تعریف قانون تطبیق هوشمند", fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("هنگامی که این کلمه در گفتار یا OCR فاکتور باشد:", fontSize = 12.sp)
                    OutlinedTextField(
                        value = keyword,
                        onValueChange = { keyword = it },
                        label = { Text("کلمه کلیدی (مثال: اسنپ، هاست، غذا)") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = categoryName,
                        onValueChange = { categoryName = it },
                        label = { Text("سرفصل پیشنهادی") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (keyword.isNotBlank() && categoryName.isNotBlank()) {
                            onAddRule(keyword, categoryName)
                            showAddRuleDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryEmerald)
                ) {
                    Text("ثبت قانون")
                }
            },
            dismissButton = {
                TextButton(onClick = { showAddRuleDialog = false }) {
                    Text("انصراف")
                }
            }
        )
    }
}
