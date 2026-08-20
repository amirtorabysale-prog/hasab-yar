package com.example.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentStatus
import com.example.ui.components.*
import com.example.ui.theme.*
import com.example.util.PersianUtils

@Composable
fun DocumentsScreen(
    documents: List<DocumentEntity>,
    onSelectDocument: (DocumentEntity) -> Unit,
    onAddNewDocument: () -> Unit
) {
    var searchQuery by remember { mutableStateOf("") }
    var selectedStatusFilter by remember { mutableStateOf<DocumentStatus?>(null) }

    val filteredDocs = documents.filter { doc ->
        val matchesStatus = selectedStatusFilter == null || doc.status == selectedStatusFilter
        val matchesQuery = searchQuery.isBlank() ||
                doc.contactName.contains(searchQuery, ignoreCase = true) ||
                doc.invoiceNumber.contains(searchQuery, ignoreCase = true) ||
                doc.description.contains(searchQuery, ignoreCase = true)
        matchesStatus && matchesQuery
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = onAddNewDocument,
                containerColor = PrimaryEmerald,
                contentColor = androidx.compose.ui.graphics.Color.White,
                modifier = Modifier.testTag("add_new_doc_fab")
            ) {
                Icon(Icons.Default.Add, contentDescription = "افزودن سند جدید")
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Search Input
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("جستجو بر اساس طرف حساب، شماره فاکتور یا شرح...", fontSize = 12.sp) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                trailingIcon = {
                    if (searchQuery.isNotBlank()) {
                        IconButton(onClick = { searchQuery = "" }) {
                            Icon(Icons.Default.Clear, contentDescription = "پاک کردن")
                        }
                    }
                },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("docs_search_field")
            )

            // Status Filter Chips
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                item {
                    FilterChip(
                        selected = selectedStatusFilter == null,
                        onClick = { selectedStatusFilter = null },
                        label = { Text("همه اسناد (${PersianUtils.toPersianDigits(documents.size.toString())})") }
                    )
                }
                item {
                    val count = documents.count { it.status == DocumentStatus.APPROVED }
                    FilterChip(
                        selected = selectedStatusFilter == DocumentStatus.APPROVED,
                        onClick = { selectedStatusFilter = DocumentStatus.APPROVED },
                        label = { Text("تأییدشده (${PersianUtils.toPersianDigits(count.toString())})") }
                    )
                }
                item {
                    val count = documents.count { it.status == DocumentStatus.NEEDS_REVIEW }
                    FilterChip(
                        selected = selectedStatusFilter == DocumentStatus.NEEDS_REVIEW,
                        onClick = { selectedStatusFilter = DocumentStatus.NEEDS_REVIEW },
                        label = { Text("نیازمند بررسی (${PersianUtils.toPersianDigits(count.toString())})") }
                    )
                }
                item {
                    val count = documents.count { it.status == DocumentStatus.EXPORTED }
                    FilterChip(
                        selected = selectedStatusFilter == DocumentStatus.EXPORTED,
                        onClick = { selectedStatusFilter = DocumentStatus.EXPORTED },
                        label = { Text("خروجی داده‌شده (${PersianUtils.toPersianDigits(count.toString())})") }
                    )
                }
            }

            // Documents List
            if (filteredDocs.isEmpty()) {
                EmptyStateView(
                    icon = Icons.Default.ReceiptLong,
                    title = "سندی یافت نشد",
                    description = "هیچ سندی با فیلترهای انتخابی شما مطابقت ندارد."
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(filteredDocs) { doc ->
                        Card(
                            shape = RoundedCornerShape(12.dp),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onSelectDocument(doc) }
                                .testTag("doc_row_${doc.id}")
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(14.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                                    ) {
                                        DocumentTypeBadge(type = doc.type)
                                        Text(
                                            text = doc.contactName.ifBlank { "طرف حساب نامشخص" },
                                            fontWeight = FontWeight.Bold,
                                            fontSize = 14.sp
                                        )
                                    }
                                    DocumentStatusBadge(status = doc.status)
                                }

                                Text(
                                    text = doc.description.ifBlank { "بدون شرح اضافی" },
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2
                                )

                                Divider(color = MaterialTheme.colorScheme.surfaceVariant)

                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                        Text("فاکتور: ${doc.invoiceNumber}", fontSize = 11.sp, color = MaterialTheme.colorScheme.outline)
                                        Text(PersianUtils.toPersianDigits(doc.dateShamsi), fontSize = 11.sp, color = MaterialTheme.colorScheme.outline)
                                    }
                                    Text(
                                        text = PersianUtils.formatPrice(doc.total),
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 13.sp,
                                        color = PrimaryEmerald
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
