package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import com.example.ai.AIAssistantEngine
import com.example.data.model.CompanyEntity
import com.example.data.model.DocumentEntity
import com.example.data.model.TransactionEntity
import com.example.ui.theme.PrimaryEmerald

data class ChatMessage(
    val id: String,
    val sender: String, // "user" or "ai"
    val text: String,
    val timestamp: String = "همین الان"
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AIAssistantSheet(
    activeCompany: CompanyEntity?,
    documents: List<DocumentEntity>,
    transactions: List<TransactionEntity>,
    onDismiss: () -> Unit
) {
    var queryText by remember { mutableStateOf("") }
    var messages by remember {
        mutableStateOf(
            listOf(
                ChatMessage(
                    id = "welcome",
                    sender = "ai",
                    text = "سلام امیرحسین عزیز! من اپراتور هوشمند حسابداری شرکت «${activeCompany?.name ?: "شما"}» هستم. تمام داده‌های اسناد، فاکتورها و تراکنش‌ها را تحلیل کرده‌ام. چطور می‌توانم کمکتان کنم؟"
                )
            )
        )
    }

    val quickPrompts = listOf(
        "اسناد نیازمند بررسی چند تاست؟",
        "جمع هزینه‌های این ماه چقدر بوده؟",
        "فاکتورهای شرکت پارس رایانه",
        "تراز مالی و سود/زیان کلی"
    )

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(PrimaryEmerald),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Default.SmartToy, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
                    }
                    Column {
                        Text("دستیار مالی و اپراتور هوشمند HesabYar", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Text("مبتنی بر داده‌های واقعی ثبتی شرکت (بدون حدس و گمان)", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "بستن")
                }
            }

            Divider()

            // Quick Prompt Chips
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                items(quickPrompts) { prompt ->
                    SuggestionChip(
                        onClick = {
                            val userMsg = ChatMessage(System.currentTimeMillis().toString(), "user", prompt)
                            val aiResponseText = AIAssistantEngine.generateAnswer(
                                query = prompt,
                                documents = documents,
                                transactions = transactions,
                                currency = activeCompany?.currency ?: "تومان"
                            )
                            val aiMsg = ChatMessage((System.currentTimeMillis() + 1).toString(), "ai", aiResponseText)
                            messages = messages + userMsg + aiMsg
                        },
                        label = { Text(prompt, fontSize = 11.sp) }
                    )
                }
            }

            // Message List
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 180.dp, max = 320.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(messages) { msg ->
                    val isAi = msg.sender == "ai"
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = if (isAi) Arrangement.Start else Arrangement.End
                    ) {
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = if (isAi) MaterialTheme.colorScheme.surfaceVariant else PrimaryEmerald,
                            modifier = Modifier.widthIn(max = 280.dp)
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text(
                                    text = msg.text,
                                    color = if (isAi) MaterialTheme.colorScheme.onSurfaceVariant else Color.White,
                                    fontSize = 12.sp,
                                    lineHeight = 18.sp
                                )
                            }
                        }
                    }
                }
            }

            // Input Bar
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = queryText,
                    onValueChange = { queryText = it },
                    placeholder = { Text("سوال مالی یا گزارش‌گیری خود را بنویسید...", fontSize = 12.sp) },
                    modifier = Modifier
                        .weight(1f)
                        .testTag("ai_assistant_query_input"),
                    shape = RoundedCornerShape(24.dp),
                    singleLine = true
                )
                IconButton(
                    onClick = {
                        if (queryText.isNotBlank()) {
                            val userMsg = ChatMessage(System.currentTimeMillis().toString(), "user", queryText)
                            val aiResponseText = AIAssistantEngine.generateAnswer(
                                query = queryText,
                                documents = documents,
                                transactions = transactions,
                                currency = activeCompany?.currency ?: "تومان"
                            )
                            val aiMsg = ChatMessage((System.currentTimeMillis() + 1).toString(), "ai", aiResponseText)
                            messages = messages + userMsg + aiMsg
                            queryText = ""
                        }
                    },
                    modifier = Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .background(PrimaryEmerald)
                        .testTag("send_ai_query_btn")
                ) {
                    Icon(Icons.Default.Send, contentDescription = "ارسال", tint = Color.White)
                }
            }
        }
    }
}
